import {randomBytes} from 'node:crypto';
import {writeFileSync,existsSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const file=fileURLToPath(new URL('../.env',import.meta.url));
if(existsSync(file))throw Error('.env already exists; not overwriting it.');
let text=readFileSync(new URL('../.env.example',import.meta.url),'utf8');
for(const key of ['POSTGRES_PASSWORD','JWT_SECRET','INTERNAL_SERVICE_TOKEN','ADMIN_PASSWORD'])text=text.replace(new RegExp('^'+key+'=$','m'),key+'='+randomBytes(32).toString('hex'));
writeFileSync(file,text,{flag:'wx',mode:0o600});
console.log('Created .env with unique secrets. Read ADMIN_EMAIL / ADMIN_PASSWORD locally, then run docker compose up -d --build. Never commit .env.');
