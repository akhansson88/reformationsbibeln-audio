const core=require('../lib/core.js');
const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function fixture(view,bookId,chapter,hidden=false,strongs=false){
 const count=core.books[bookId-1].verses[chapter-1];
 const href=(b,n)=>`./fromgettopost.php?prog=${view}&book=${b}&chap=${n}&col=ffe&txt=1.112&rub=yes&vnum=${hidden?'no':'yes'}&font=Verdana`;
 const menus=`<div id="Demo">${core.books.map(b=>`<a href="${escape(href(b.id,1))}">${escape(b.abbreviation)}</a>`).join('')}</div><div id="Demo2">${Array.from({length:core.books[bookId-1].verses.length},(_,i)=>`<a href="${escape(href(bookId,i+1))}">${i+1}</a>`).join('')}</div>`;
 const share=`https://bibelonline.se/fromgettopost.php?prog=${view}&book=${bookId}&chap=${chapter}`;
 const rows=Array.from({length:count},(_,i)=>{
  const n=i+1,text=`Text för vers ${n}. Svenska ord, kursiv text <font color="#555"><i>och ord</i></font>.`;
  if(view==='studyb')return `<tr class="mytr"><td class="mytd"><span class="locmyspan"><small>${n}</small></span></td><td class="myspan"><span class="locmyspan">${text}${strongs?' <a href="#strong">G2424</a>':''}</span></td><td class="mytd"><a href="#reference">[r]</a></td><td class="mytd"></td></tr>`;
  return `${i===4?'<br><span style="font-family:Verdana;color:#999"><b>Underrubrik</b></span><br>':''}${hidden?'':`<span style="color:#000"><small><sup>${n}</sup></small>&nbsp;</span>`}<span style="font-family:Verdana;font-size:1.112rem">${text}</span> `;
 }).join('');
 const table=view==='studyb'?`<table class="mytable1"><tr><td colspan="4">Rubrik</td></tr>${rows}</table>`:`<table class="mytable"><tr><td><span style="font-family:Verdana"><b>Rubrik</b></span><br>${rows}</td></tr></table>`;
 return `<!doctype html><html lang="sv"><head><title>${view}</title></head><body>${menus}<a href="mailto:?subject=Kapitel&amp;body=${encodeURIComponent(share)}">Dela</a>${table}</body></html>`;
}
module.exports={fixture};
