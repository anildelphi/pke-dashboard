const PASSWORD = '9Ldoms0zwH627mfv';
const COOKIE_NAME = 'pke_auth';

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.png|login).*)'],
};

export default function middleware(request) {
  const cookie = request.cookies.get(COOKIE_NAME);
  
  if (cookie?.value === PASSWORD) {
    return; // Authenticated, continue
  }
  
  // Redirect to login page
  const url = new URL('/login', request.url);
  return Response.redirect(url);
}
