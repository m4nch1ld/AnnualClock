import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/server/auth";

export async function POST(request: NextRequest) {
  await auth.signOut();
  return NextResponse.redirect(new URL("/login", request.url), { status: 303 });
}
