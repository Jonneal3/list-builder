import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";

export async function POST(request: NextRequest) {
  try {
    // Create a signal file to notify the orchestrator that login is confirmed
    // The orchestrator runs from the industry-finder directory, so we need to create the file there
    const signalFile = path.join(process.cwd(), '..', 'industry-finder', 'apollo_login_signal.tmp');
    fs.writeFileSync(signalFile, 'confirmed');
    console.log('Apollo login confirmed via POST - signal file created');
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error confirming Apollo login:', error);
    return NextResponse.json({ error: 'Failed to confirm login' }, { status: 500 });
  }
}
