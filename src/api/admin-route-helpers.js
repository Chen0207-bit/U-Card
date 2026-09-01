import { requireDirector, requireSales } from '../auth/authorize.js';

const protect = authorize => handler => async request => authorize(request.context) || handler(request);

export const salesOnly = protect(requireSales);
export const directorOnly = protect(requireDirector);
export const actorId = request => request.context.actor.id;
