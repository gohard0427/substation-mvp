import {mkdir,rm,readFile,writeFile,copyFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
const root=fileURLToPath(new URL('../',import.meta.url));
await rm(root+'dist',{recursive:true,force:true});await mkdir(root+'dist',{recursive:true});
for(const file of ['index.html','style.css','app.js']){
 let source=await readFile(root+'static/'+file,'utf8');
 if(file==='index.html')source=source.replace('최대 200MB','최대 90MiB').replace('<link rel="stylesheet" href="style.css">','<link rel="stylesheet" href="fonts.css"><link rel="stylesheet" href="style.css">');
 if(file==='style.css')source=source.replace(/^@import url\([^\n]+\);\s*/,'');
 await writeFile(root+'dist/'+file,source);
}
await build({entryPoints:[root+'static/browser-engine.mjs'],bundle:true,format:'esm',platform:'browser',target:'es2022',outfile:root+'dist/browser-engine.mjs',logLevel:'warning'});
await build({entryPoints:[root+'static/reference-admin.mjs'],bundle:true,format:'esm',platform:'browser',target:'es2022',outfile:root+'dist/reference-admin.mjs',logLevel:'warning'});
await build({entryPoints:[root+'static/fonts.css'],bundle:true,outfile:root+'dist/fonts.css',loader:{'.woff2':'file','.woff':'file'},assetNames:'fonts/[name]-[hash]',logLevel:'warning'});
await copyFile(root+'deploy/pages-headers',root+'dist/_headers');
await writeFile(root+'dist/_routes.json',JSON.stringify({version:1,include:['/api/*'],exclude:[]},null,2)+'\n');
console.log('Built Cloudflare Pages UI, sequential browser image/ZIP engine, bundled Korean font and API routes. No runtime secrets copied.');

await copyFile(root+"node_modules/@fontsource/noto-sans-kr/LICENSE",root+"dist/FONT-LICENSE.txt");
await copyFile(root+"node_modules/@zip.js/zip.js/LICENSE",root+"dist/ZIP-LICENSE.txt");
