import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { deflateRawSync } from 'node:zlib';
const root=path.resolve(import.meta.dirname,'..');
execFileSync(process.execPath,[path.join(root,'scripts/check-export.mjs')],{stdio:'inherit'});
const version=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version;
const out=path.join(path.dirname(root),`RagChat-${version}.zip`);
const replace=process.argv.includes('--replace');
if(fs.existsSync(out)&&!replace)throw new Error('Release already exists: '+out+' (use --replace to refresh this generated archive)');
const skip=new Set(['node_modules','.git','.venv','__pycache__','.runtime','data','backups','coverage']);
const allowedRoots=new Set(['api','web','rag-service','scripts','docs']);
const rootFiles=new Set(['.env.example','.gitattributes','.gitignore','Caddyfile','CONTRIBUTING.md','docker-compose.yml','LICENSE','package-lock.json','package.json','README.md','README.ru.md','SECURITY.md','CHANGELOG.md']);
const allowed=/\.(?:js|mjs|ts|tsx|json|md|yml|yaml|py|sql|html|css|svg|txt|conf|webmanifest|png|jpg|jpeg|ico|ps1)$|^(?:Dockerfile|Caddyfile|\.dockerignore)$/;
const files=[];
function walk(dir){
  for(const e of fs.readdirSync(dir,{withFileTypes:true})){
    if(skip.has(e.name)||e.isSymbolicLink()||e.name.startsWith('.env')||e.name.endsWith('.tsbuildinfo'))continue;
    const p=path.join(dir,e.name);
    if(e.isDirectory())walk(p);
    else if(allowed.test(e.name))files.push(p);
  }
}
for(const e of fs.readdirSync(root,{withFileTypes:true})){
  if(e.isDirectory()&&allowedRoots.has(e.name))walk(path.join(root,e.name));
  else if(e.isFile()&&rootFiles.has(e.name))files.push(path.join(root,e.name));
}
if(!fs.existsSync(path.join(root,'web/dist/index.html')))throw new Error('Run npm run build before packaging.');
const crcTable=Array.from({length:256},(_,i)=>{let c=i;for(let k=0;k<8;k++)c=(c&1)?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
const crc32=(data)=>{let c=0xffffffff;for(const b of data)c=crcTable[(c^b)&255]^(c>>>8);return (c^0xffffffff)>>>0;};
const local=[],central=[];let offset=0;
for(const file of files.sort()){
  const name=Buffer.from('RagChat/'+path.relative(root,file).replaceAll('\\','/'));
  const data=fs.readFileSync(file),compressed=deflateRawSync(data),crc=crc32(data);
  const h=Buffer.alloc(30);h.writeUInt32LE(0x04034b50);h.writeUInt16LE(20,4);h.writeUInt16LE(0x800,6);h.writeUInt16LE(8,8);
  h.writeUInt16LE(0x0021,12);h.writeUInt32LE(crc,14);h.writeUInt32LE(compressed.length,18);h.writeUInt32LE(data.length,22);h.writeUInt16LE(name.length,26);
  local.push(h,name,compressed);
  const c=Buffer.alloc(46);c.writeUInt32LE(0x02014b50);c.writeUInt16LE(20,4);c.writeUInt16LE(20,6);c.writeUInt16LE(0x800,8);c.writeUInt16LE(8,10);
  c.writeUInt16LE(0x0021,14);c.writeUInt32LE(crc,16);c.writeUInt32LE(compressed.length,20);c.writeUInt32LE(data.length,24);c.writeUInt16LE(name.length,28);c.writeUInt32LE(offset,42);
  central.push(c,name);offset+=h.length+name.length+compressed.length;
}
const directory=Buffer.concat(central),end=Buffer.alloc(22);
end.writeUInt32LE(0x06054b50);end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
fs.writeFileSync(out,Buffer.concat([...local,directory,end]),{flag:replace?'w':'wx'});
console.log(`Created ${out}: ${files.length} files, ${fs.statSync(out).size} bytes. Includes source and built frontend; excludes credentials, databases, dependencies and Git history.`);
