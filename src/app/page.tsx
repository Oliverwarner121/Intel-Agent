import { listBriefingDefinitions } from "@/briefings/registry";

export default function Home() {
  const briefings = listBriefingDefinitions();
  return (
    <main>
      <h1>Intel-Agent</h1>
      <p>Personal automated intelligence briefings. Briefings are delivered by email; there is no dashboard.</p>
      <h2>Registered briefings</h2>
      <ul>
        {briefings.map((briefing) => (
          <li key={briefing.id}>
            <strong>{briefing.name}</strong> {briefing.enabled ? "" : "(disabled)"}
            <br />
            {briefing.description}
            <br />
            <small>{briefing.schedule.description}</small>
          </li>
        ))}
      </ul>
    </main>
  );
}
