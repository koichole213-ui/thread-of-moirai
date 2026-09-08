export function mountTabs(root) { const $ = s => root.querySelector(s); const $$ = s => [...root.querySelectorAll(s)];
const tabBar=$('.tabs'),path=$('#sheet-shape'),svg=$('.tab-sheet'),tabs=$$('[role=tab]');
const reduceMotion=matchMedia('(prefers-reduced-motion: reduce)');
let position=0,target=0,velocity=0,raf=0,lastTime=0,activeTab=0;
function drawSheet(){
  const w=tabBar.clientWidth,h=77,pad=parseFloat(getComputedStyle(tabBar).paddingLeft),buttonWidth=(w-2*pad)/2;
  if(!w)return;
  const cx=pad+buttonWidth/2+position*buttonWidth;
  const stretch=Math.min(Math.abs(velocity)*7,13),half=buttonWidth*.40+stretch;
  const l=cx-half,r=cx+half,shoulder=Math.min(22,l-2,w-r-2),top=9,base=h,corner=24;
  svg.setAttribute('viewBox',`0 0 ${w} ${h}`);
  path.setAttribute('d',`M0 ${base} L${l-shoulder} ${base} Q${l} ${base} ${l} ${base-shoulder} L${l} ${top+corner} Q${l} ${top} ${l+corner} ${top} L${r-corner} ${top} Q${r} ${top} ${r} ${top+corner} L${r} ${base-shoulder} Q${r} ${base} ${r+shoulder} ${base} L${w} ${base} L${w} ${h+2} L0 ${h+2} Z`);
}
function frame(t){const dt=Math.min((t-(lastTime||t))/1000,.032);lastTime=t;const spring=105,damping=20;velocity+=(spring*(target-position)-damping*velocity)*dt;position+=velocity*dt;
  if(Math.abs(target-position)<.0008&&Math.abs(velocity)<.008){position=target;velocity=0;drawSheet();raf=0;lastTime=0;return;}drawSheet();raf=requestAnimationFrame(frame);
}
function switchTab(i){
  if(activeTab===i)return;activeTab=i;target=i;
  tabs.forEach((tab,n)=>{tab.setAttribute('aria-selected',String(n===i));tab.tabIndex=n===i?0:-1;});
  const panels=[$('#play-panel'),$('#outline-panel')];panels.forEach((p,n)=>p.hidden=n!==i);
  if(!reduceMotion.matches){panels[i].getAnimations().forEach(a=>a.cancel());panels[i].animate([{opacity:0,transform:`translateY(5px)`},{opacity:1,transform:'translateY(0)'}],{duration:280,easing:'cubic-bezier(.2,.7,.2,1)'});if(!raf){lastTime=0;raf=requestAnimationFrame(frame);}}
  else{cancelAnimationFrame(raf);raf=0;position=target;velocity=0;drawSheet();}
}
tabs.forEach((tab,i)=>{tab.onclick=()=>switchTab(i);tab.onkeydown=e=>{let next;if(e.key==='ArrowRight'||e.key==='ArrowLeft')next=1-i;else if(e.key==='Home')next=0;else if(e.key==='End')next=1;else return;e.preventDefault();switchTab(next);tabs[next].focus();};});
const resize = new ResizeObserver(drawSheet); resize.observe(tabBar);
const motionChange = ()=>{if(reduceMotion.matches){cancelAnimationFrame(raf);raf=0;position=target;velocity=0;drawSheet();}}; reduceMotion.addEventListener('change', motionChange);


return { switchTab, draw: drawSheet, dispose() { resize.disconnect(); cancelAnimationFrame(raf); reduceMotion.removeEventListener('change', motionChange); } }; }
