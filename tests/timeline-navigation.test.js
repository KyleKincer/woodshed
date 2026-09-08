import {expect, test} from 'vitest';
import {boundedView, wheelNavigation} from '../src/js/timeline-navigation.js';

test('repeated panning against both boundaries preserves the zoom span', () => {
  let view = {start: 20, end: 40};
  for (let i = 0; i < 100; i++) view = boundedView(view.start + 7, view.end + 7, 100);
  expect(view).toEqual({start: 80, end: 100});
  for (let i = 0; i < 100; i++) view = boundedView(view.start - 7, view.end - 7, 100);
  expect(view).toEqual({start: 0, end: 20});
  expect(boundedView(-25, 25, 100)).toEqual({start: 0, end: 50});
  expect(boundedView(95, 115, 100)).toEqual({start: 80, end: 100});
  expect(boundedView(0, 0.25, 0.1)).toEqual({start: 0, end: 0.1});
});
test('horizontal momentum cannot switch to zoom when vertical noise becomes dominant', () => {
  const wheel = wheelNavigation();
  expect(wheel({deltaX: 30, deltaY: 2}, 1000, 0)).toEqual({mode:'pan', delta:30});
  expect(wheel({deltaX: 0.1, deltaY: -3}, 1000, 40)).toEqual({mode:'pan', delta:0.1});
  expect(wheel({deltaX: 0, deltaY: -1}, 1000, 70)).toEqual({mode:'pan', delta:0});
  expect(wheel({deltaX: 0, deltaY: -4}, 1000, 400)).toEqual({mode:'zoom', delta:-4});
});
test('explicit modifiers override a gesture and wheel units are normalized', () => {
  const wheel = wheelNavigation();
  expect(wheel({deltaX:0,deltaY:2,shiftKey:true,deltaMode:1},1000,0)).toEqual({mode:'pan',delta:32});
  expect(wheel({deltaX:0,deltaY:-5,ctrlKey:true},1000,20)).toEqual({mode:'zoom',delta:-5});
  expect(wheel({deltaX:1,deltaY:0,deltaMode:2},1000,400)).toEqual({mode:'pan',delta:1000});
});
