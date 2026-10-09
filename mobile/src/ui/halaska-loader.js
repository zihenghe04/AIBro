// Emit the already reviewed offline bridge as one unchanged asset, including its
// complete notices. Do not import the raw Kit: its upstream styles load fonts online.
import bridgeURL from "../../../app/halaska-ui.js?url";
import fontURL from "../../../app/halaska-geist.woff2?url";

let loading;
export function loadMobileHalaska() {
  if (!document.getElementById("mobile-halaska-font")) {
    const style = document.createElement("style");
    style.id = "mobile-halaska-font";
    style.textContent = `@font-face{font-family:"AI Bro Mobile Geist";src:url(${JSON.stringify(fontURL)}) format("woff2");font-weight:100 900;font-style:normal;font-display:swap}`;
    document.head.append(style);
  }
  if (globalThis.HalaskaUI) return Promise.resolve(globalThis.HalaskaUI);
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = bridgeURL;
    script.async = true;
    script.dataset.mobileHalaska = "true";
    script.onload = () => {
      if (globalThis.HalaskaUI) resolve(globalThis.HalaskaUI);
      else { script.remove(); reject(Error("同步界面组件未能加载，请重新打开此页面")); }
    };
    script.onerror = () => { script.remove(); reject(Error("同步界面组件未能加载，请重新打开此页面")); };
    document.head.append(script);
  }).catch(error => { loading = null; throw error; });
  return loading;
}
