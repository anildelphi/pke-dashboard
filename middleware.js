const PASSWORD = '9Ldoms0zwH627mfv';
const COOKIE_NAME = 'pke_auth';

export const config = {
  matcher: ['/((?!api|_next|favicon.png|login).*)'],
};

export default function middleware(request) {
  const url = new URL(request.url);
  
  // Skip login page and API routes
  if (url.pathname === '/login' || url.pathname.startsWith('/api/')) {
    return;
  }
  
  const cookieHeader = request.headers.get('cookie') || '';
  const cookies = Object.fromEntries(
    cookieHeader.split('; ').filter(Boolean).map(c => c.split('='))
  );
  
  if (cookies[COOKIE_NAME] === PASSWORD) {
    return; // Authenticated
  }
  
  // Redirect to login
  return Response.redirect(new URL('/login', request.url), 302);
}
