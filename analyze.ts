import * as fs from 'fs';

const content = fs.readFileSync('frontend/src/source/demo.ts', 'utf8');
const lines = content.split('\n');
console.log("demo.ts line 44:", lines[43]);

const renderer = fs.readFileSync('frontend/src/render/renderer.ts', 'utf8');
const rLines = renderer.split('\n');
console.log("renderer.ts line 44:", rLines[43]);
