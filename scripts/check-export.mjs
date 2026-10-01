import fs from 'node:fs';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');
const issues=[];
const skip=new Set(['node_modules','.git','.venv','__pycache__','.runtime','data','backups','coverage']);
const blocked=[['sal','vim'],['sel','vim'],['сэл','вим'],['сел','вим'],['мед','пред'],['мед','эксперт'],['медицин','ск'],['гал','авит'],['хепи','клим'],['вир','фертил'],['mary','shev'],['гинеко','лог'],['гастроэнтеро','лог']].map(parts=>parts.join(''));
const extensions=/\.(?:js|mjs|ts|tsx|json|md|yml|yaml|py|sql|html|css|svg|txt|conf|webmanifest)$|(?:^|\/)(?:Dockerfile|Caddyfile)$/;
function inspect(file,text){
  const rel=path.relative(root,file).replaceAll('\\','/');
  if(/-----BEGIN (?:OPENSSH|RSA|EC|DSA) PRIVATE KEY-----/.test(text))issues.push(rel+': private key');
  if(/\bsk-[A-Za-z0-9_-]{24,}/.test(text))issues.push(rel+': possible model API token');
  const lowered=text.toLowerCase();
  for(const word of blocked)if(lowered.includes(word))issues.push(rel+': non-neutral content');
  // Installation-specific addresses are represented by segments so the scanner does not flag itself.
  for(const segments of [[135,106,192,139],[185,9,25,177],[217,177,44,94]])if(text.includes(segments.join('.')))issues.push(rel+': installation-specific host');
}
function walk(dir){
  for(const e of fs.readdirSync(dir,{withFileTypes:true})){
    if(skip.has(e.name)||e.name.startsWith('.env')&&e.name!=='.env.example')continue;
    const p=path.join(dir,e.name);
    if(e.isDirectory())walk(p);
    else if(extensions.test(e.name)||e.name==='.env.example')inspect(p,fs.readFileSync(p,'utf8'));
  }
}
walk(root);
const env=fs.readFileSync(path.join(root,'.env.example'),'utf8');
for(const key of ['POSTGRES_PASSWORD','JWT_SECRET','INTERNAL_SERVICE_TOKEN','ADMIN_PASSWORD','MODEL_API_KEY','SEARCH_API_KEY','VAPID_PUBLIC_KEY','VAPID_PRIVATE_KEY','SMTP_PASSWORD']){
  if(new RegExp('^'+key+'=.+$','m').test(env))issues.push('.env.example: secret placeholder must be empty');
}
if(issues.length){console.error([...new Set(issues)].join('\n'));process.exit(1);}
console.log('Neutral source, built UI and secret-template scan passed. Runtime data and private .env are excluded from releases.');
