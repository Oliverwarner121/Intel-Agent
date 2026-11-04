import type { Metadata } from "next";

export const metadata: Metadata = { title: "Privacy policy | Intel-Agent" };

export default function PrivacyPolicy() {
  return (
    <main>
      <h1>Intel-Agent privacy policy</h1>
      <p>
        Intel-Agent is a personal tool used only by its owner. It requests read-only access to the owner&apos;s
        Google Calendar to list the day&apos;s events in a private morning briefing email.
      </p>
      <h2>Data use</h2>
      <ul>
        <li>Calendar events are read when a briefing is generated and are only included in an email sent to the owner.</li>
        <li>Calendar data is not stored, sold, shared with third parties or used for advertising or AI training.</li>
        <li>Access can be revoked at any time from your Google Account under Security → Third-party connections.</li>
      </ul>
      <p>Intel-Agent&apos;s use of information received from Google APIs adheres to the Google API Services User Data Policy, including the Limited Use requirements.</p>
    </main>
  );
}
