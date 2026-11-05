const fs=require('fs'),path=require('path');
const ENG=path.resolve(__dirname,'..');
const {CARDS,validateDeck}=require(ENG);
const norm=s=>s.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]/g,'');
const byName=new Map();for(const c of CARDS){const k=norm(c.name);if(!byName.has(k))byName.set(k,c);}
function parseTxt(file){const legends=[],cards=[],unknown=[];
 for(const line of fs.readFileSync(file,'utf8').split(/\r?\n/)){const m=line.match(/^(\d+)\s+(.+)$/);if(!m)continue;
  const c=byName.get(norm(m[2]));if(!c){unknown.push(m[2]);continue;}
  if(c.type==='Legend')legends.push(c.number);else cards.push({card_id:c.number,count:+m[1]});}
 return {name:path.basename(file),legends,cards,unknown};}
module.exports={parseTxt,ENG};
if(require.main===module){for(const f of process.argv.slice(2)){const d=parseTxt(f);const v=validateDeck(d);console.log(d.name,'legends',d.legends.length,'cards',d.cards.reduce((a,x)=>a+x.count,0),'unknown',d.unknown,'errors',v.errors,'warnings',v.warnings);}}
