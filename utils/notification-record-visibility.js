"use strict";

// Serialised into a trusted notification renderer. This observes painted content
// text, not screenshot readiness: sequential descriptions, GIF settle gates,
// pulse animations and a disabled Screenshot option must not suppress replay.
function installNotificationRecordVisibility(options={}) {
  window.__achievementsRecordVisibility?.dispose();
  const normalize=s=>String(s||"").replace(/\s+/g," ").trim().toLowerCase();
  const wanted=normalize(options.displayName);
  const selectors="[data-notification-content='title'],.title-inner,.achievement-title,#title,.title,.notification-title,.ach-title,.achievement-name";
  const started=performance.now(),deadline=started+Math.max(1000,Number(options.durationMs)||8000);
  let timer=null,disposed=false,reported=false,paintedFrames=0;
  function visibleWidth(rect,element) {
    let left=Math.max(0,rect.left),right=Math.min(document.documentElement.clientWidth,rect.right),top=Math.max(0,rect.top),bottom=Math.min(document.documentElement.clientHeight,rect.bottom),opacity=1;
    for(let parent=element;parent;parent=parent.parentElement) {
      const style=getComputedStyle(parent);
      if(style.display==="none" || style.visibility!=="visible")return 0;
      opacity*=Number(style.opacity);
      // Root overflow propagates to the real viewport, not a possibly empty
      // body box. Preset adapters can override innerWidth/innerHeight.
      if(parent!==document.body && parent!==document.documentElement) {
        const bounds=parent.getBoundingClientRect();
        if(/hidden|clip|auto|scroll/.test(style.overflowX)){left=Math.max(left,bounds.left);right=Math.min(right,bounds.right);}
        if(/hidden|clip|auto|scroll/.test(style.overflowY)){top=Math.max(top,bounds.top);bottom=Math.min(bottom,bounds.bottom);}
      }
    }
    return opacity>=0.8 && bottom-top>=Math.min(rect.height*0.7,10) ? Math.max(0,right-left) : 0;
  }
  function check() {
    const titles=[...document.querySelectorAll(selectors)].filter(e=>normalize(e.textContent));
    const candidates=wanted ? titles.filter(e=>normalize(e.textContent).includes(wanted)) : titles;
    let total=0,painted=0;
    for(const element of candidates) {
      const walker=document.createTreeWalker(element,NodeFilter.SHOW_TEXT);let node;
      while((node=walker.nextNode())) {
        if(!normalize(node.textContent))continue;
        const range=document.createRange();range.selectNodeContents(node);
        const rect=range.getBoundingClientRect();if(!rect.width || !rect.height)continue;
        total+=rect.width;
        painted+=visibleWidth(rect,node.parentElement);
      }
      if(total>0 && painted>=Math.min(24,total*0.7))return {ready:true,reason:"painted-title",elapsedMs:Math.round(performance.now()-started)};
    }
    // Some saved SAN themes intentionally show only the game name or icon.
    // A replay observes the notification appearing; it must not require an
    // achievement title/description that the selected theme has disabled.
    if(performance.now()-started>=500) {
      for(const element of document.querySelectorAll("[data-notification-content]")) {
        if(!normalize(element.textContent))continue;
        const walker=document.createTreeWalker(element,NodeFilter.SHOW_TEXT);let node;
        while((node=walker.nextNode())) {
          if(!normalize(node.textContent))continue;
          const range=document.createRange();range.selectNodeContents(node);const rect=range.getBoundingClientRect();
          if(rect.width>0 && visibleWidth(rect,node.parentElement)>=Math.min(24,rect.width*0.7))return {ready:true,reason:"painted-content",elapsedMs:Math.round(performance.now()-started)};
        }
      }
      for(const image of document.images) {
        if(!image.complete || !image.naturalWidth || !image.getAttribute("src"))continue;
        const rect=image.getBoundingClientRect();
        if(rect.width>=16 && rect.height>=16 && visibleWidth(rect,image)>=Math.min(24,rect.width*0.7))return {ready:true,reason:"painted-image",elapsedMs:Math.round(performance.now()-started)};
      }
    }
    return {ready:false,reason:"waiting-for-painted-title",elapsedMs:Math.round(performance.now()-started)};
  }
  function tick() {
    if(disposed || reported)return;
    const sample=check();paintedFrames=sample.ready ? paintedFrames+1 : 0;
    if(paintedFrames>=2){reported=true;window.api?.notificationRecordVisible?.(sample);return;}
    if(performance.now()>=deadline){reported=true;return;}
    timer=setTimeout(()=>requestAnimationFrame(tick),30);
  }
  const controller={check,dispose(){disposed=true;clearTimeout(timer);}};
  window.__achievementsRecordVisibility=controller;
  requestAnimationFrame(tick);
  return true;
}
module.exports={installNotificationRecordVisibility};
