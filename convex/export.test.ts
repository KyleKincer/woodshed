import { expect, test, vi, afterEach } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
vi.mock('../src/js/backend.js', () => ({exportPage:vi.fn(),getConfig:vi.fn(),signKeys:vi.fn(),getNotation:vi.fn(async()=>null)}));
import * as backend from '../src/js/backend.js';
import { exportLibrary } from '../src/js/export.js';
import {emptyScore,fraction,durationOf} from '../shared/notation';
afterEach(()=>{vi.unstubAllGlobals();vi.clearAllMocks();});
test('whole-library streaming export creates readable audio and settings archive',async()=>{
 const chunks:Uint8Array[]=[];
 const close=vi.fn(),abort=vi.fn(async()=>{});
 vi.stubGlobal('window',{showSaveFilePicker:async()=>({createWritable:async()=>({write:async(c:Uint8Array)=>{chunks.push(c);},close,abort})})});
 const audio=new Uint8Array([10,20,30,40]);
 vi.stubGlobal('fetch',async()=>new Response(audio));
 const song={id:'song1',title:'Practice',duration:20,practice:{loop:{a:1,b:2,enabled:true}},stems:[{name:'drums',key:'users/owner/drums.webm',bytes:4}],coverKey:null};
 vi.mocked(backend.exportPage).mockResolvedValue({page:[song],isDone:true,continueCursor:''});
 vi.mocked(backend.getConfig).mockResolvedValue({settings:{bitrate:192}});
 vi.mocked(backend.signKeys).mockResolvedValue({'users/owner/drums.webm':'https://example.test/audio'});
 const score={...emptyScore(20),layout:'split'};score.bars=[{measureId:score.timeline.measures[0].id,coverage:'reviewed',hits:[],tuplets:[{start:fraction(0),length:fraction(1),count:5}]}];
 vi.mocked(backend.getNotation).mockResolvedValueOnce({score,revision:1});
 await exportLibrary();
 const bytes=new Uint8Array(chunks.reduce((sum,c)=>sum+c.length,0));let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
 const archive=unzipSync(bytes);
 expect(archive['Practice-song1/drums.webm']).toEqual(audio);
 expect(JSON.parse(strFromU8(archive['manifest.json'])).songs[0].practice).toEqual(song.practice);
 expect(JSON.parse(strFromU8(archive['settings.json']))).toEqual({bitrate:192});
 expect(JSON.parse(strFromU8(archive['Practice-song1/drums.woodshed.json']))).toEqual({format:'woodshed-notation',version:2,song:{title:'Practice',duration:20},score});
 expect(close).toHaveBeenCalledOnce();expect(abort).not.toHaveBeenCalled();
});
test('failed download aborts the destination instead of reporting a complete export',async()=>{
 const abort=vi.fn(async()=>{}),close=vi.fn();
 vi.stubGlobal('window',{showSaveFilePicker:async()=>({createWritable:async()=>({write:async()=>{},close,abort})})});
 vi.stubGlobal('fetch',async()=>new Response('missing',{status:404}));
 vi.mocked(backend.exportPage).mockResolvedValue({page:[{id:'song1',title:'Missing',stems:[{key:'audio',bytes:4}]}],isDone:true,continueCursor:''});
 vi.mocked(backend.getConfig).mockResolvedValue({settings:{}});
 vi.mocked(backend.signKeys).mockResolvedValue({audio:'https://example.test/audio'});
 await expect(exportLibrary()).rejects.toThrow('Could not export');
 expect(abort).toHaveBeenCalledOnce();expect(close).not.toHaveBeenCalled();
});
test('exported notation is always current, including version 1 parts and mixed rows',async()=>{
 const chunks:Uint8Array[]=[];
 vi.stubGlobal('window',{showSaveFilePicker:async()=>({createWritable:async()=>({write:async(c:Uint8Array)=>{chunks.push(c);},close:async()=>{},abort:async()=>{}})})});
 const songs=[{id:'old',title:'Old',artist:'Band',duration:20,stems:[]},{id:'mixed',title:'Mixed',duration:20,stems:[]}];
 vi.mocked(backend.exportPage).mockResolvedValue({page:songs,isDone:true,continueCursor:''});
 vi.mocked(backend.getConfig).mockResolvedValue({settings:{}});vi.mocked(backend.signKeys).mockResolvedValue({});
 const base=emptyScore(20),[first,second]=base.timeline.measures;
 const v1=(id:string,instrument:string,offset=fraction(0))=>({id,offset,duration:durationOf(4),instrument,voice:1,value:4,dotted:false,tuplet:1,accent:true,ghost:false,flam:false,sticking:'R',velocity:.9});
 const legacy={measureId:first.id,coverage:'reviewed',hits:[v1('snare','snare'),v1('rest','rest',fraction(1))]};
 const current={measureId:second.id,coverage:'progress',hits:[{id:'kick',offset:fraction(1,3),instrument:'kick',voice:2,accent:false,ghost:false,flam:false,sticking:'',velocity:.75,roll:1}]};
 vi.mocked(backend.getNotation).mockResolvedValueOnce({score:{version:1,title:'Old drums',timeline:base.timeline,bars:[legacy]},revision:3})
  .mockResolvedValueOnce({score:{version:2,title:'Mixed drums',layout:'split',timeline:base.timeline,bars:[legacy,current]},revision:4});
 await exportLibrary();
 const bytes=new Uint8Array(chunks.reduce((sum,c)=>sum+c.length,0));let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
 const archive=unzipSync(bytes),read=(name:string)=>JSON.parse(strFromU8(archive[name]));
 const upgraded={measureId:first.id,coverage:'reviewed',hits:[{id:'snare',offset:fraction(0),instrument:'snare',voice:1,accent:true,ghost:false,flam:false,sticking:'R',velocity:.9}]};
 expect(read('Old-old/drums.woodshed.json')).toEqual({format:'woodshed-notation',version:2,song:{title:'Old',artist:'Band',duration:20},score:{version:2,title:'Old drums',timeline:base.timeline,bars:[upgraded]}});
 expect(read('Mixed-mixed/drums.woodshed.json').score).toEqual({version:2,title:'Mixed drums',layout:'split',timeline:base.timeline,bars:[upgraded,current]});
});
