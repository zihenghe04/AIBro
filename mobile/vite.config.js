import { defineConfig } from 'vite';
import { createHandler } from './api/ucas.mjs';
const handler = createHandler(fetch, ['http://127.0.0.1:8899','http://127.0.0.1:8900']);
const mount = server => { server.middlewares.use((req,res,next) => {
  if (req.url?.split('?')[0] === '/api/ucas') return handler(req,res);
  next();
}); };
export default defineConfig({plugins:[{name:'local-school-transport',configureServer:mount,configurePreviewServer:mount}]});
