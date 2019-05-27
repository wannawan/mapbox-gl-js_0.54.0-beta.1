// @flow

import { FillLayoutArray } from '../array_types';
import libtess from 'libtess/libtess.debug.js'

import { members as layoutAttributes } from './fill_attributes';
import SegmentVector from '../segment';
import { ProgramConfigurationSet } from '../program_configuration';
import { LineIndexArray, TriangleIndexArray } from '../index_array_type';
import earcut from 'earcut';
import classifyRings from '../../util/classify_rings';
import assert from 'assert';
const EARCUT_MAX_RINGS = 500;
import { register } from '../../util/web_worker_transfer';
import {hasPattern, addPatternDependencies} from './pattern_bucket_features';
import loadGeometry from '../load_geometry';
import EvaluationParameters from '../../style/evaluation_parameters';

import type {
    Bucket,
    BucketParameters,
    BucketFeature,
    IndexedFeature,
    PopulateParameters
} from '../bucket';
import type FillStyleLayer from '../../style/style_layer/fill_style_layer';
import type Context from '../../gl/context';
import type IndexBuffer from '../../gl/index_buffer';
import type VertexBuffer from '../../gl/vertex_buffer';
import type Point from '@mapbox/point-geometry';
import type {FeatureStates} from '../../source/source_state';
import type {ImagePosition} from '../../render/image_atlas';

class FillBucket implements Bucket {
    index: number;
    zoom: number;
    overscaling: number;
    layers: Array<FillStyleLayer>;
    layerIds: Array<string>;
    stateDependentLayers: Array<FillStyleLayer>;
    stateDependentLayerIds: Array<string>;

    layoutVertexArray: FillLayoutArray;
    layoutVertexBuffer: VertexBuffer;

    indexArray: TriangleIndexArray;
    indexBuffer: IndexBuffer;

    indexArray2: LineIndexArray;
    indexBuffer2: IndexBuffer;

    hasPattern: boolean;
    programConfigurations: ProgramConfigurationSet<FillStyleLayer>;
    segments: SegmentVector;
    segments2: SegmentVector;
    uploaded: boolean;
    features: Array<BucketFeature>;

    constructor(options: BucketParameters<FillStyleLayer>) {
        this.zoom = options.zoom;
        this.overscaling = options.overscaling;
        this.layers = options.layers;
        this.layerIds = this.layers.map(layer => layer.id);
        this.index = options.index;
        this.hasPattern = false;

        this.layoutVertexArray = new FillLayoutArray();
        this.indexArray = new TriangleIndexArray();
        this.indexArray2 = new LineIndexArray();
        this.programConfigurations = new ProgramConfigurationSet(layoutAttributes, options.layers, options.zoom);
        this.segments = new SegmentVector();
        this.segments2 = new SegmentVector();
        this.stateDependentLayerIds = this.layers.filter((l) => l.isStateDependent()).map((l) => l.id);

    }

    populate(features: Array<IndexedFeature>, options: PopulateParameters) {
        this.features = [];
        this.hasPattern = hasPattern('fill', this.layers, options);

        for (const {feature, index, sourceLayerIndex} of features) {
            if (!this.layers[0]._featureFilter(new EvaluationParameters(this.zoom), feature)) continue;

            const geometry = loadGeometry(feature);

            const patternFeature: BucketFeature = {
                sourceLayerIndex,
                index,
                geometry,
                properties: feature.properties,
                type: feature.type,
                patterns: {}
            };

            if (typeof feature.id !== 'undefined') {
                patternFeature.id = feature.id;
            }

            if (this.hasPattern) {
                this.features.push(addPatternDependencies('fill', this.layers, patternFeature, this.zoom, options));
            } else {
                this.addFeature(patternFeature, geometry, index, {});
            }

            options.featureIndex.insert(feature, geometry, index, sourceLayerIndex, this.index);
        }
    }

    update(states: FeatureStates, vtLayer: VectorTileLayer, imagePositions: {[string]: ImagePosition}) {
        if (!this.stateDependentLayers.length) return;
        this.programConfigurations.updatePaintArrays(states, vtLayer, this.stateDependentLayers, imagePositions);
    }

    addFeatures(options: PopulateParameters, imagePositions: {[string]: ImagePosition}) {
        for (const feature of this.features) {
            const {geometry} = feature;
            this.addFeature(feature, geometry, feature.index, imagePositions);
        }
    }

    isEmpty() {
        return this.layoutVertexArray.length === 0;
    }

    uploadPending(): boolean {
        return !this.uploaded || this.programConfigurations.needsUpload;
    }
    upload(context: Context) {
        if (!this.uploaded) {
            this.layoutVertexBuffer = context.createVertexBuffer(this.layoutVertexArray, layoutAttributes);
            this.indexBuffer = context.createIndexBuffer(this.indexArray);
            this.indexBuffer2 = context.createIndexBuffer(this.indexArray2);
        }
        this.programConfigurations.upload(context);
        this.uploaded = true;
    }

    destroy() {
        if (!this.layoutVertexBuffer) return;
        this.layoutVertexBuffer.destroy();
        this.indexBuffer.destroy();
        this.indexBuffer2.destroy();
        this.programConfigurations.destroy();
        this.segments.destroy();
        this.segments2.destroy();
    }

    addFeature(feature: BucketFeature, geometry: Array<Array<Point>>, index: number, imagePositions: {[string]: ImagePosition}) {
        for (const polygon of classifyRings(geometry, EARCUT_MAX_RINGS)) {
            let numVertices = 0;
            for (const ring of polygon) {
                numVertices += ring.length;
            }

            const triangleSegment = this.segments.prepareSegment(numVertices, this.layoutVertexArray, this.indexArray);
            const triangleIndex = triangleSegment.vertexLength;

            const flattened = [];
            const holeIndices = [];

            for (const ring of polygon) {
                if (ring.length === 0) {
                    continue;
                }

                if (ring !== polygon[0]) {
                    holeIndices.push(flattened.length / 2);
                }

                const lineSegment = this.segments2.prepareSegment(ring.length, this.layoutVertexArray, this.indexArray2);
                const lineIndex = lineSegment.vertexLength;

                this.layoutVertexArray.emplaceBack(ring[0].x, ring[0].y);
                this.indexArray2.emplaceBack(lineIndex + ring.length - 1, lineIndex);
                flattened.push(ring[0].x);
                flattened.push(ring[0].y);

                for (let i = 1; i < ring.length; i++) {
                    this.layoutVertexArray.emplaceBack(ring[i].x, ring[i].y);
                    this.indexArray2.emplaceBack(lineIndex + i - 1, lineIndex + i);
                    flattened.push(ring[i].x);
                    flattened.push(ring[i].y);
                }

                lineSegment.vertexLength += ring.length;
                lineSegment.primitiveLength += ring.length;
            }

            //let  indices = earcut(flattened, holeIndices);

            const vertexCallback = (data, polyVertArray)  => {
                polyVertArray[polyVertArray.length] = data[0];
                polyVertArray[polyVertArray.length] = data[1];
            };

            const begincallback = (type) => {
                if (type !== libtess.primitiveType.GL_TRIANGLES) {
                    console.log('expected TRIANGLES but got type: ' + type);
                }
            };

            const errorcallback = (errno)  => {
                console.log('error callback');
                console.log('error number: ' + errno);
            };

            const combinecallback = (coords, data, weight) => {
                //console.log('combine callback');
                return [coords[0], coords[1], coords[2]];
            };

            const edgeCallback = (flag) =>  {
                // don't really care about the flag, but need no-strip/no-fan behavior
                // console.log('edge flag: ' + flag);
            };

            let contours = [],
                point_map = {},
                point_count = 0,
                tessy = new libtess.GluTesselator(),
                triangleVerts = [],
                new_indices = [];

            polygon.map((poly) => {
                let new_poly = [];
                const poly_len = poly.length;
                poly.map((point, index) =>{
                    new_poly.push(point.x);
                    new_poly.push(point.y);
                    point_map[point.x*8192 + point.y] = point_count;
                    point_count +=1;
                });
                contours.push(new_poly);
            });

            tessy.gluTessCallback(libtess.gluEnum.GLU_TESS_VERTEX_DATA, vertexCallback);
            tessy.gluTessCallback(libtess.gluEnum.GLU_TESS_BEGIN, begincallback);
            tessy.gluTessCallback(libtess.gluEnum.GLU_TESS_ERROR, errorcallback);
            tessy.gluTessCallback(libtess.gluEnum.GLU_TESS_COMBINE, combinecallback);
            tessy.gluTessCallback(libtess.gluEnum.GLU_TESS_EDGE_FLAG, edgeCallback);

            tessy.gluTessNormal(0, 0, 1);

            tessy.gluTessBeginPolygon(triangleVerts);

            for (var i = 0; i < contours.length; i++) {
                tessy.gluTessBeginContour();
                var contour = contours[i];
                for (var j = 0; j < contour.length; j += 2) {
                    var coords = [contour[j], contour[j + 1], 0];
                    tessy.gluTessVertex(coords, coords);
                }
                tessy.gluTessEndContour();
            }
            tessy.gluTessEndPolygon();

            for (let i=0; i<triangleVerts.length; i=i+2) {
                let map_index = triangleVerts[i]*8192+triangleVerts[i+1];
                let p_i =point_map[map_index];
                new_indices.push(p_i);
            }

             let indices = new_indices;

            assert(indices.length % 3 === 0);

            for (let i = 0; i < indices.length; i += 3) {
                this.indexArray.emplaceBack(
                    triangleIndex + indices[i],
                    triangleIndex + indices[i + 1],
                    triangleIndex + indices[i + 2]);
            }

            triangleSegment.vertexLength += numVertices;
            triangleSegment.primitiveLength += indices.length / 3;
        }
        this.programConfigurations.populatePaintArrays(this.layoutVertexArray.length, feature, index, imagePositions);
    }

    xxx () {
                    // let combined_polygons = [];
            // for (let p in polygon) {
            //     combined_polygons = combined_polygons.concat(polygon[p]);
            // }
            //
            // console.log('combined_polygons', combined_polygons)
            // let polygons = [];
            // for (let i = 0; i < indices.length; i = i+3) {
            //     let indice1 = indices[i];
            //     let indice2 = indices[i + 1];
            //     let indice3 = indices[i + 2];
            //
            //     let poly= [];
            //     poly.push(combined_polygons[indice1])
            //     poly.push(combined_polygons[indice2])
            //     poly.push(combined_polygons[indice3])
            //     polygons.push(poly)
            // }
            // console.log("new polygon", polygons);
            // let st_polygons = [];
            // //st_polygons.push('(8192 0, 8192 8192, 0 8192, 0 0, 8192 0)')
            // for (let i in polygons){
            //     let poly = polygons[i];
            //     let st_polygon = [];
            //     //console.log("polygon", polygon)
            //     for (let j in poly) {
            //         let point = poly[j];
            //        // console.log('point', point)
            //         st_polygon.push(point.x + ' ' + point.y)
            //     }
            //     st_polygon.push(poly[0].x + ' ' + poly[0].y)
            //
            //     st_polygons.push('('+st_polygon.join(', ')+')')
            // }
            //
            // console.log(st_polygons.join(', '));

    }
}

register('FillBucket', FillBucket, {omit: ['layers', 'features']});

export default FillBucket;
