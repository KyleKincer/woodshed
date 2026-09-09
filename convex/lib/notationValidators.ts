import {v} from 'convex/values';
export const fractionValidator=v.object({n:v.number(),d:v.number()});
export const timelineValidator=v.object({version:v.literal(1),measures:v.array(v.object({id:v.string(),numerator:v.number(),denominator:v.number(),length:fractionValidator,label:v.string(),grouping:v.optional(v.array(v.number()))})),anchors:v.array(v.object({position:fractionValidator,time:v.number()}))});
export const hitValidator=v.object({id:v.string(),offset:fractionValidator,duration:fractionValidator,instrument:v.string(),voice:v.union(v.literal(1),v.literal(2)),value:v.number(),dotted:v.boolean(),tuplet:v.number(),accent:v.boolean(),ghost:v.boolean(),flam:v.boolean(),sticking:v.union(v.literal(''),v.literal('L'),v.literal('R')),velocity:v.number()});
export const barValidator=v.object({measureId:v.string(),coverage:v.union(v.literal('unstarted'),v.literal('progress'),v.literal('reviewed')),hits:v.array(hitValidator)});
export const headerValidator=v.object({version:v.literal(1),title:v.string(),timeline:timelineValidator});
