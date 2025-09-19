"use client";

import { useRef, useState } from "react";

type Plan = { directories: string[]; angles: string[] };

const CORE_DIRS = [
  "yellowpages.com","manta.com","bbb.org","superpages.com","merchantcircle.com",
  "cylex.us.com","cityfos.com","find-us-here.com","tuugo.us","brownbook.net",
  "iglobal.co","company-list.org","yalwa.com","hotfrog.com","citysquares.com",
  "localstack.com","us-info.com"
];

function deterministicPlan(industry: string): Plan {
  const base = industry.trim();
  const angles = [
    base,
    `${base} companies`,
    `${base} directory`,
    `top ${base} companies`,
    `${base} suppliers`,
    `${base} associations members`,
    `best ${base}`,
    `${base} services`,
  ];
  return { directories: CORE_DIRS, angles };
}

export default function Home() {
  const [industry, setIndustry] = useState("");
  const [plan, setPlan] = useState<Plan | null>(null);
  const [rows, setRows] = useState<any[]>([]);
  const esRef = useRef<EventSource | null>(null);

  function onPlan() {
    if (!industry.trim()) return;
    setPlan(deterministicPlan(industry));
    setRows([]);
  }

  async function onRun() {
    // Placeholder streaming: demonstrate UI; wire to backend later
    setRows([]);
    // Insert a few demo rows so UI shows activity
    const demo = [
      { type: "plan", directory: plan?.directories[0] || "yellowpages.com", angle: plan?.angles[0] || industry },
      { type: "plan", directory: plan?.directories[1] || "manta.com", angle: plan?.angles[1] || industry },
    ];
    setRows(demo);
  }

  return (
    <main className="max-w-5xl mx-auto p-6">
      <h1 className="text-3xl font-bold">AI Industry Explorer</h1>
      <p className="text-gray-600 mb-4">Enter an industry to generate a plan and stream results.</p>

      <div className="flex gap-2 items-center mb-4">
        <input className="border rounded px-3 py-2 flex-1" placeholder="e.g., nail salons, painting companies" value={industry} onChange={(e) => setIndustry(e.target.value)} />
        <button className="bg-blue-600 text-white px-4 py-2 rounded" onClick={onPlan}>Plan</button>
        <button className="bg-green-600 text-white px-4 py-2 rounded" onClick={onRun} disabled={!plan}>Run</button>
      </div>

      {plan && (
        <div className="mb-4">
          <h2 className="font-semibold">Planned Directories</h2>
          <div className="flex flex-wrap gap-2 mb-2">
            {plan.directories.map((d) => (
              <span key={d} className="bg-blue-100 text-blue-800 px-2 py-1 rounded text-sm">{d}</span>
            ))}
          </div>
          <h2 className="font-semibold">Angles</h2>
          <div className="flex flex-wrap gap-2">
            {plan.angles.map((a) => (
              <span key={a} className="bg-gray-100 text-gray-800 px-2 py-1 rounded text-sm">{a}</span>
            ))}
          </div>
        </div>
      )}

      <table className="w-full border-collapse">
        <thead>
          <tr className="bg-gray-100">
            <th className="text-left p-2 border">Event</th>
            <th className="text-left p-2 border">Directory</th>
            <th className="text-left p-2 border">Angle</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td className="p-2 border">{r.type}</td>
              <td className="p-2 border">{r.directory}</td>
              <td className="p-2 border">{r.angle}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
