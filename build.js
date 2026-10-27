// 编译：把 public/ 下的 css/js 内联进单个 dist/index.html，双击即可在浏览器打开
const fs = require('fs');
const path = require('path');

const pub = path.join(__dirname, 'public');
let html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(pub, 'style.css'), 'utf8');
const js = fs.readFileSync(path.join(pub, 'game.js'), 'utf8');

html = html.replace('<link rel="stylesheet" href="style.css">', () => `<style>\n${css}\n</style>`);
html = html.replace('<script src="game.js"></script>', () => `<script>\n${js}\n</script>`);

fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true });
const out = path.join(__dirname, 'dist', 'index.html');
fs.writeFileSync(out, html);
console.log(`✅ 编译完成: ${out}（${(html.length / 1024).toFixed(1)} KB，双击即可玩）`);
