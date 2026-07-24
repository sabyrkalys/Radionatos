import { mkdir, copyFile, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const rootDir = process.cwd();
const distDir = resolve(rootDir, 'dist');
const sourceHtmlPath = resolve(rootDir, 'index.html');
const sourceCssPath = resolve(rootDir, 'styles.css');
const distHtmlPath = resolve(distDir, 'index.html');
const distCssPath = resolve(distDir, 'styles.css');
const launcherHtmlPath = resolve(rootDir, 'RadiantOS_Standalone.html');

await mkdir(distDir, { recursive: true });
await copyFile(sourceCssPath, distCssPath);

const sourceHtml = await readFile(sourceHtmlPath, 'utf8');

function renderHtml(cssHref, scriptSrc) {
  return sourceHtml
    .replace('./styles.css', cssHref)
    .replace('<script type="module" src="./app/main.ts"></script>', `<script src="${scriptSrc}"></script>`);
}

await writeFile(distHtmlPath, renderHtml('./styles.css', './radiantos-app.js'), 'utf8');
await writeFile(launcherHtmlPath, renderHtml('./dist/styles.css', './dist/radiantos-app.js'), 'utf8');
