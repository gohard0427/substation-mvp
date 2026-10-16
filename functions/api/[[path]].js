import {proxy} from '../../cloudflare/proxy.mjs';
export function onRequest(context) { return proxy(context.request,context.env); }
