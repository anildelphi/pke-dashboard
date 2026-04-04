import { NextResponse } from 'next/server';

const PASSWORD = '9Ldoms0zwH627mfv';
const COOKIE_NAME = 'pke_auth';

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.png|login).*)'],
};

export function middleware(request) {
  const cookie = request.cookies.get(COOKIE_NAME);
  
  if (cookie?.value === PASSWORD) {
    return NextResponse.next();
  }
  
  const url = request.nextUrl.clone();
  url.pathname = '/login';
  return NextResponse.redirect(url);
}
