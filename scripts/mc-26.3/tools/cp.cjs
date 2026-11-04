// Prints a Windows classpath for a launcher version json: node cp.cjs <version>
const fs = require('fs'), path = require('path')
const mc = path.join(process.env.APPDATA, '.minecraft')
const v = process.argv[2]
const j = JSON.parse(fs.readFileSync(path.join(mc, 'versions', v, v + '.json'), 'utf8'))
const allowed = (rules) => {
  if (!rules) return true
  let ok = false
  for (const r of rules) {
    const osOk = !r.os || r.os.name === 'windows'
    if (osOk) ok = r.action === 'allow'
  }
  return ok
}
const cp = []
for (const lib of j.libraries) {
  if (!allowed(lib.rules)) continue
  const a = lib.downloads && lib.downloads.artifact
  if (a) cp.push(path.join(mc, 'libraries', a.path))
}
cp.push(path.join(mc, 'versions', v, v + '.jar'))
console.log(cp.filter(p => fs.existsSync(p)).join(';'))
