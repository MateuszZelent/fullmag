import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
const b = await chromium.launch({executablePath:'/opt/pw-browsers/chromium'});
const p = await b.newPage({viewport:{width:1680,height:1000}});
await p.goto('file:///home/claude/fsd/mockups/start-screen.html');
await p.waitForTimeout(400);
const audit = async (theme) => {
  await p.selectOption('#mk-theme', theme);
  await p.waitForTimeout(250);
  return p.evaluate(() => {
    const lin = c => { c/=255; return c<=0.03928 ? c/12.92 : Math.pow((c+0.055)/1.055,2.4); };
    const L = rgb => { const [r,g,b]=rgb; return .2126*lin(r)+.7152*lin(g)+.0722*lin(b); };
    const parse = s => {
      const m = s.match(/color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
      if (m) return [+m[1]*255, +m[2]*255, +m[3]*255];
      return (s.match(/[\d.]+/g)||[0,0,0]).slice(0,3).map(Number);
    };
    // Composite every translucent layer down, so a 13 %-alpha banner tint is
    // not mistaken for an opaque background.
    const alphaOf = s => {
      if (/transparent/.test(s)) return 0;
      const slash = s.match(/\/\s*([\d.]+%?)\s*\)/);
      if (slash) return slash[1].endsWith('%') ? parseFloat(slash[1])/100 : parseFloat(slash[1]);
      const m = s.match(/rgba?\(([^)]+)\)/);
      if (m) { const p=m[1].split(',').map(x=>parseFloat(x)); return p.length>3?p[3]:1; }
      return 1;
    };
    const bgOf = el => {
      const stack=[]; let n=el;
      while(n && n!==document.documentElement){
        const c=getComputedStyle(n).backgroundColor, a=alphaOf(c);
        if(a>0) stack.push([parse(c),a]);
        if(a>=1) break;
        n=n.parentElement;
      }
      if(!stack.length) return [255,255,255];
      let out = stack[stack.length-1][0];
      for(let i=stack.length-2;i>=0;i--){ const [c,a]=stack[i];
        out = out.map((v,j)=>c[j]*a + v*(1-a)); }
      return out;
    };
    const ratio=(a,b)=>{const la=L(a),lb=L(b),hi=Math.max(la,lb),lo=Math.min(la,lb);return (hi+.05)/(lo+.05);};
    const out=[];
    document.querySelectorAll('.fm-content, .fm-rail, .fm-inspector, .fm-status').forEach(root=>{
      root.querySelectorAll('*').forEach(el=>{
        const t=[...el.childNodes].filter(n=>n.nodeType===3 && n.textContent.trim()).map(n=>n.textContent.trim()).join(' ');
        if(!t) return;
        const cs=getComputedStyle(el);
        if(cs.visibility==='hidden'||cs.display==='none') return;
        const fs=parseFloat(cs.fontSize);
        const r=ratio(parse(cs.color), bgOf(el));
        const bold=parseInt(cs.fontWeight,10)>=700;
        const large = fs>=18.66 || (fs>=14 && bold);
        const need = large?3:4.5;
        if(r < need) out.push({text:t.slice(0,44), fs:+fs.toFixed(1), ratio:+r.toFixed(2), need});
      });
    });
    const seen=new Set();
    return out.filter(o=>{const k=o.text+o.fs; if(seen.has(k))return false; seen.add(k); return true;});
  });
};
for (const th of ['dark','light']) {
  const res = await audit(th);
  console.log(`\n${th.toUpperCase()} — ${res.length} element(s) below WCAG AA`);
  res.slice(0,14).forEach(r=>console.log(`  ${r.ratio.toFixed(2)} (need ${r.need}) ${r.fs}px  "${r.text}"`));
}
await b.close();
