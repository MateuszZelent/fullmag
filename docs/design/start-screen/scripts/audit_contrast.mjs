import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import fs from 'fs';
const src = fs.readFileSync(new URL('./_audit_core.mjs', import.meta.url), 'utf8');
const fn = src.slice(src.indexOf('return p.evaluate(() => {')+'return p.evaluate(() => {'.length, src.lastIndexOf('  });'));
const b = await chromium.launch({executablePath:'/opt/pw-browsers/chromium'});
const p = await b.newPage({viewport:{width:1680,height:1000}});
await p.goto('file://' + process.cwd() + '/mockups/start-screen.html');
await p.waitForTimeout(400);
let total=0;
for (const theme of ['dark','light']) {
  for (const [state,sec] of [['loaded','home'],['first-run','home'],['loading','home'],['error','home'],
                             ['loaded','templates'],['loaded','import'],['loaded','learn'],
                             ['loaded','settings'],['loaded','about']]) {
    await p.selectOption('#mk-theme', theme);
    await p.selectOption('#mk-state', state);
    await p.selectOption('#mk-sec', sec);
    await p.waitForTimeout(200);
    const res = await p.evaluate(new Function(fn));
    total += res.length;
    const tag = `${theme}/${state}/${sec}`;
    if (res.length) {
      console.log(`${tag.padEnd(26)} ${res.length} below AA`);
      res.slice(0,5).forEach(r=>console.log(`    ${r.ratio.toFixed(2)} (need ${r.need}) ${r.fs}px "${r.text}"`));
    } else {
      console.log(`${tag.padEnd(26)} clean`);
    }
  }
}
console.log(`\nTOTAL below WCAG AA: ${total}`);
await b.close();
