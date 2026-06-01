/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */
import{l as t}from"./editor.api2-AsNCLb-7.js";import"./toggleHighContrast-CS8ieQzx.js";const n={},s={};class i{static getOrCreate(e){return s[e]||(s[e]=new i(e)),s[e]}constructor(e){this._languageId=e,this._loadingTriggered=!1,this._lazyLoadPromise=new Promise((a,o)=>{this._lazyLoadPromiseResolve=a,this._lazyLoadPromiseReject=o})}load(){return this._loadingTriggered||(this._loadingTriggered=!0,n[this._languageId].loader().then(e=>this._lazyLoadPromiseResolve(e),e=>this._lazyLoadPromiseReject(e))),this._lazyLoadPromise}}function d(r){const e=r.id;n[e]=r,t.register(r);const a=i.getOrCreate(e);t.registerTokensProviderFactory(e,{create:async()=>(await a.load()).language}),t.onLanguageEncountered(e,async()=>{const o=await a.load();t.setLanguageConfiguration(e,o.conf)})}export{d as r};
//# sourceMappingURL=_.contribution-BCyjvbUH.js.map
