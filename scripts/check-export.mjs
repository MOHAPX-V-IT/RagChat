import fs from 'node:fs';import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');const issues=[];
const skip=new Set(['node_modules','dist','.git','.venv','__pycache__','.runtime','data']);
function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){if(skip.has(e.name)||e.name.startsWith('.env')&&e.name!=='.env.example')continue;const p=path.join(dir,e.name);if(e.isDirectory())walk(p);else if(/\.(js|ts|tsx|json|md|yml|py|sql|html)$/.test(e.name)){
const s=fs.readFileSync(p,'utf8');
if(/-----BEGIN (?:OPENSSH|RSA|EC) PRIVATE KEY-----/.test(s))issues.push(path.relative(root,p)+': private key');
if(/sk-[A-Za-z0-9_-]{24,}/.test(s))issues.push(path.relative(root,p)+': possible API token');
}}}walk(root);
if(issues.length){console.error(issues.join('\n'));process.exit(1);}console.log('Source scan passed. Ignored runtime/secret files must never be included in release archives.');
