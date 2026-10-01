import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const root=path.resolve(import.meta.dirname,'..');
const local=path.join(root,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
const python=process.env.PYTHON || (existsSync(local)?local:'python3');
const result=spawnSync(python,['-m','unittest','discover','-s','rag-service','-v'],{cwd:root,stdio:'inherit'});
if(result.error){console.error('Python not available. Set PYTHON to your Python executable or create .venv.');process.exit(1);}
process.exit(result.status??1);
