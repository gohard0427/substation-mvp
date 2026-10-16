import {mkdir,rm,readFile,writeFile,copyFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const root = fileURLToPath(new URL('../',import.meta.url));
await rm(root+'dist',{recursive:true,force:true});
await mkdir(root+'dist',{recursive:true});
// Explicit allowlist: server code, data, .env and credentials never enter dist.
for (const file of ['index.html','style.css','app.js']) {
  let source = await readFile(root+'static/'+file,'utf8');
  if (file === 'index.html') source = source.replace('최대 200MB','최대 90MiB');
  await writeFile(root+'dist/'+file,source);
}
await copyFile(root+'deploy/pages-headers',root+'dist/_headers');
await writeFile(root+'dist/_routes.json',JSON.stringify({version:1,include:['/api/*'],exclude:[]},null,2)+'\n');
console.log('Cloudflare Pages output: dist (3 UI assets, headers and API routing).');
