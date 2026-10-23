import * as fs from 'fs';

const content = fs.readFileSync('frontend/src/render/renderer.ts', 'utf8');
const lines = content.split('\n');
console.log("Renderer.ts 25-60:");
for(let i=24; i<60; i++) {
  console.log(`${i+1}: ${lines[i]}`);
}
