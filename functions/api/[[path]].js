import {proxy} from '../../cloudflare/proxy.mjs';
import {freeGateway} from '../../cloudflare/free-api.mjs';
export function onRequest(context) { return context.env.DEPLOY_TARGET==='python' ? proxy(context.request,context.env) : freeGateway(context.request,context.env); }
