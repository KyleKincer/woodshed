import { expect, test, vi, afterEach } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
vi.mock('../src/js/backend.js', () => ({exportPage:vi.fn(),getConfig:vi.fn(),signKeys:vi.fn()}));
import * as backend from '../src/js/backend.js';
import { exportLibrary } from '../src/js/export.js';
afterEach(()=>{vi.unstubAllGlobals();vi.clearAllMocks();});
test('whole-library streaming export creates readable audio and settings archive',async()=>{
 const chunks:Uint8Array[]=[];
 const close=vi.fn(),abort=vi.fn(async()=>{});
 vi.stubGlobal('window',{showSaveFilePicker:async()=>({createWritable:async()=>({write:async(c:Uint8Array)=>{chunks.push(c);},close,abort})})});
 const audio=new Uint8Array([10,20,30,40]);
 vi.stubGlobal('fetch',async()=>new Response(audio));
 const song={id:'song1',title:'Practice',practice:{loop:{a:1,b:2,enabled:true}},stems:[{name:'drums',key:'users/owner/drums.webm',bytes:4}],coverKey:null};
 vi.mocked(backend.exportPage).mockResolvedValue({page:[song],isDone:true,continueCursor:''});
 vi.mocked(backend.getConfig).mockResolvedValue({settings:{bitrate:192}});
 vi.mocked(backend.signKeys).mockResolvedValue({'users/owner/drums.webm':'https://example.test/audio'});
 await exportLibrary();
 const bytes=new Uint8Array(chunks.reduce((sum,c)=>sum+c.length,0));let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
 const archive=unzipSync(bytes);
 expect(archive['Practice-song1/drums.webm']).toEqual(audio);
 expect(JSON.parse(strFromU8(archive['manifest.json'])).songs[0].practice).toEqual(song.practice);
 expect(JSON.parse(strFromU8(archive['settings.json']))).toEqual({bitrate:192});
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
