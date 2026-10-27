import {v} from 'convex/values';
export const fractionValidator=v.object({n:v.number(),d:v.number()});
export const timelineValidator=v.object({version:v.literal(1),measures:v.array(v.object({id:v.string(),numerator:v.number(),denominator:v.number(),length:fractionValidator,label:v.string(),grouping:v.optional(v.array(v.number()))})),anchors:v.array(v.object({position:fractionValidator,time:v.number()}))});
const sticking=v.union(v.literal(''),v.literal('L'),v.literal('R'));
/** Version 1 hits stored authored durations. Existing rows stay readable and are upgraded by clients. */
export const hitV1Validator=v.object({id:v.string(),offset:fractionValidator,duration:fractionValidator,instrument:v.string(),voice:v.union(v.literal(1),v.literal(2)),value:v.number(),dotted:v.boolean(),tuplet:v.number(),accent:v.boolean(),ghost:v.boolean(),flam:v.boolean(),sticking,velocity:v.number()});
export const hitValidator=v.object({id:v.string(),offset:fractionValidator,instrument:v.string(),voice:v.union(v.literal(1),v.literal(2)),accent:v.boolean(),ghost:v.boolean(),flam:v.boolean(),sticking,velocity:v.number(),heavy:v.optional(v.boolean()),drag:v.optional(v.boolean()),roll:v.optional(v.number())});
export const tupletValidator=v.object({start:fractionValidator,length:fractionValidator,count:v.number(),voice:v.optional(v.union(v.literal(1),v.literal(2)))});
export const barValidator=v.object({measureId:v.string(),coverage:v.union(v.literal('unstarted'),v.literal('progress'),v.literal('reviewed')),hits:v.array(v.union(hitValidator,hitV1Validator)),tuplets:v.optional(v.array(tupletValidator))});
export const headerValidator=v.union(
  v.object({version:v.literal(1),title:v.string(),timeline:timelineValidator}),
  v.object({version:v.literal(2),title:v.string(),layout:v.optional(v.union(v.literal('split'),v.literal('combined'))),timeline:timelineValidator}),
);
