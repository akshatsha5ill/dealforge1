export default function PrivacyPolicy() {
  const styles = {
    container: { padding: '48px 24px', maxWidth: '800px', margin: '0 auto', color: 'var(--text-primary)', fontFamily: 'var(--font-body)' },
    title: { fontSize: '32px', marginBottom: '8px', color: 'var(--accent-primary)' },
    updated: { color: 'var(--text-secondary)', fontSize: '14px', marginBottom: '24px' },
    h2: { marginTop: '36px', fontSize: '22px', color: 'var(--text-primary)', borderTop: '1px solid var(--border)', paddingTop: '24px' },
    h3: { marginTop: '20px', fontSize: '16px', color: 'var(--accent-primary)' },
    p: { color: 'var(--text-secondary)', fontSize: '15px', lineHeight: 1.7, marginTop: '10px' },
    li: { color: 'var(--text-secondary)', fontSize: '15px', lineHeight: 1.7, marginTop: '6px' },
    strong: { color: 'var(--text-primary)' },
  };

  return (
    <div style={styles.container}>
      <h1 style={styles.title}>Privacy Policy</h1>
      <p style={styles.updated}>Last updated: {new Date().toLocaleDateString()}</p>

      <h2 style={styles.h2}>1. Introduction</h2>
      <p style={styles.p}>
        DealForge ("we", "our", "us") provides AI-powered meeting intelligence, lead scoring, and email follow-up
        tools for sales teams. This Privacy Policy explains what information we collect, how we use it, how long we
        keep it, and the choices you have — including how to access or delete your data. It applies to our Zoom
        Marketplace app, our web application, and all related services (collectively, "DealForge").
      </p>
      <p style={styles.p}>
        <strong style={styles.strong}>Our core design principle is privacy by default.</strong> Your meeting content
        — transcripts, AI analyses, lead records, and email drafts — is stored locally in your browser using
        IndexedDB and never permanently stored on our servers.
      </p>

      <h2 style={styles.h2}>2. Information We Collect</h2>

      <h3 style={styles.h3}>2.1 Data stored on your device (local-first)</h3>
      <p style={styles.p}>The following data is created and stored exclusively in your browser's local IndexedDB:</p>
      <ul style={{ paddingLeft: '24px', marginTop: '8px' }}>
        <li style={styles.li}>Meeting transcripts and their AI analyses (summaries, action items, sentiment)</li>
        <li style={styles.li}>Lead records, BANT scores, and deal pipeline data</li>
        <li style={styles.li}>Email drafts, drip campaign templates, and outreach history</li>
        <li style={styles.li}>Your AI provider API keys (OpenAI, Anthropic, Gemini) and Resend key — encrypted on your device with AES-256-GCM (PBKDF2, 600K iterations)</li>
        <li style={styles.li}>Settings, preferences, and local backup files you choose to export</li>
      </ul>
      <p style={styles.p}>
        This data belongs to you. It stays on your device, works offline, and can be exported or deleted at any time.
      </p>

      <h3 style={styles.h3}>2.2 Data we process on our servers (minimal)</h3>
      <p style={styles.p}>We operate a stateless relay architecture. The only information we process server-side is:</p>
      <ul style={{ paddingLeft: '24px', marginTop: '8px' }}>
        <li style={styles.li}><strong style={styles.strong}>Account data:</strong> your email address, display name, and authentication UID, provided when you sign up with Firebase Authentication (email/password or Google).</li>
        <li style={styles.li}><strong style={styles.strong}>Subscription data:</strong> your plan (Free/Pro/Enterprise) and billing status, used to enforce feature access.</li>
        <li style={styles.li}><strong style={styles.strong}>OAuth connection metadata:</strong> when you connect Zoom, Gmail, or Outlook, we store your access/refresh tokens — encrypted at rest (AES-256-GCM) — and the connected account identifier, so we can authenticate API calls on your behalf.</li>
        <li style={styles.li}><strong style={styles.strong}>Usage counters:</strong> a count of analyzed meetings per month (per Free-tier quota) and anonymized feature-usage counts.</li>
        <li style={styles.li}><strong style={styles.strong}>Transient relay buffer:</strong> during a live Zoom meeting, transcript segments and meeting context are held in an in-memory server buffer for up to 24 hours to bridge the in-meeting panel to your dashboard. This buffer is never written to permanent storage and is purged automatically.</li>
      </ul>

      <h3 style={styles.h3}>2.3 Data you provide to Zoom</h3>
      <p style={styles.p}>
        When you use DealForge inside a Zoom meeting, we request the minimal Zoom OAuth scopes needed for the
        feature to work: <strong style={styles.strong}>meeting:read</strong> (meeting context and topic) and
        <strong style={styles.strong}> user:read</strong> (account linking and deauthorization). We do not access
        cloud recordings. Meeting participant names and audio appear in the live transcript only while you are in
        the meeting and are relayed to your own dashboard.
      </p>

      <h2 style={styles.h2}>3. How We Use Information</h2>
      <p style={styles.p}>We use the information described above only for the following purposes:</p>
      <ul style={{ paddingLeft: '24px', marginTop: '8px' }}>
        <li style={styles.li}>Provide, operate, and maintain DealForge features (analysis, lead scoring, emails, pipeline)</li>
        <li style={styles.li}>Process transcript analysis using the AI provider you select (see Section 4)</li>
        <li style={styles.li}>Send transactional emails (password reset, receipts) via Resend</li>
        <li style={styles.li}>Process subscription payments via Dodo Payments</li>
        <li style={styles.li}>Enforce free-tier quotas and prevent abuse</li>
        <li style={styles.li}>Improve the product using aggregated, privacy-respecting usage counts</li>
      </ul>
      <p style={styles.p}>
        We never sell your personal information, never show it to other users, and never use your meeting content
        to train AI models.
      </p>

      <h2 style={styles.h2}>4. Bring Your Own Key (BYOK) &amp; AI Processing</h2>
      <p style={styles.p}>
        You choose which AI provider analyzes your transcripts — OpenAI, Anthropic, or Google Gemini. You may
        provide your own API keys (encrypted locally in your browser), in which case your transcript content goes
        directly from your browser to that provider. Alternatively, you may use our server-side key, in which case
        the transcript text is passed through our relay to the provider and is not retained. Transcript content is
        sent to an AI provider <em>only when you run an analysis</em>.
      </p>
      <p style={styles.p}>
        Each AI provider applies its own privacy policy to data it receives. You should review the policies of
        whichever provider you choose. We do not share meeting content with any other third party.
      </p>

      <h2 style={styles.h2}>5. Third-Party Services</h2>
      <p style={styles.p}>DealForge relies on the following third-party services. Each receives only the data necessary for its function:</p>
      <ul style={{ paddingLeft: '24px', marginTop: '8px' }}>
        <li style={styles.li}><strong style={styles.strong}>Firebase (Google):</strong> authentication and account storage (email, UID, encrypted OAuth tokens).</li>
        <li style={styles.li}><strong style={styles.strong}>OpenAI / Anthropic / Google Gemini:</strong> transcript analysis when you run it.</li>
        <li style={styles.li}><strong style={styles.strong}>Zoom:</strong> OAuth, live transcription, meeting webhooks.</li>
        <li style={styles.li}><strong style={styles.strong}>Google Gmail / Microsoft Outlook:</strong> sending email through your own connected account.</li>
        <li style={styles.li}><strong style={styles.strong}>Resend:</strong> transactional email delivery.</li>
        <li style={styles.li}><strong style={styles.strong}>Dodo Payments:</strong> payment processing for subscriptions (card details are handled by Dodo; we never see or store card numbers).</li>
        <li style={styles.li}><strong style={styles.strong}>Sentry (optional):</strong> error monitoring with error-redaction configured to exclude meeting content.</li>
      </ul>

      <h2 style={styles.h2}>6. Data Retention</h2>
      <p style={styles.p}>
        We keep each category of data only as long as needed for the purpose described below. Meeting content has
        no server-side copy — deletion in your browser removes it from DealForge entirely.
      </p>
      <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: '12px', fontSize: '14px', lineHeight: 1.6 }}>
        <thead>
          <tr>
            <th style={{ textAlign: 'left', padding: '8px', borderBottom: '1px solid var(--border)', color: 'var(--text-primary)' }}>Data category</th>
            <th style={{ textAlign: 'left', padding: '8px', borderBottom: '1px solid var(--border)', color: 'var(--text-primary)' }}>Retention</th>
            <th style={{ textAlign: 'left', padding: '8px', borderBottom: '1px solid var(--border)', color: 'var(--text-primary)' }}>Notes</th>
          </tr>
        </thead>
        <tbody style={{ color: 'var(--text-secondary)' }}>
          <tr>
            <td style={{ padding: '8px', borderBottom: '1px solid var(--border)' }}>Relay buffer (transcript segments, meeting context)</td>
            <td style={{ padding: '8px', borderBottom: '1px solid var(--border)' }}>24 hours</td>
            <td style={{ padding: '8px', borderBottom: '1px solid var(--border)' }}>In-memory only, never written to permanent storage; purged automatically.</td>
          </tr>
          <tr>
            <td style={{ padding: '8px', borderBottom: '1px solid var(--border)' }}>Email tracking events (open/click inbox)</td>
            <td style={{ padding: '8px', borderBottom: '1px solid var(--border)' }}>24 hours</td>
            <td style={{ padding: '8px', borderBottom: '1px solid var(--border)' }}>Transient inbox only; stored only with recipient consent, then pulled/deleted.</td>
          </tr>
          <tr>
            <td style={{ padding: '8px', borderBottom: '1px solid var(--border)' }}>Local data (IndexedDB: transcripts, analyses, leads, emails, keys, settings)</td>
            <td style={{ padding: '8px', borderBottom: '1px solid var(--border)' }}>User-controlled</td>
            <td style={{ padding: '8px', borderBottom: '1px solid var(--border)' }}>Kept until you delete it, your browser evicts it, or you clear browser storage.</td>
          </tr>
          <tr>
            <td style={{ padding: '8px', borderBottom: '1px solid var(--border)' }}>Free-tier transcript visibility</td>
            <td style={{ padding: '8px', borderBottom: '1px solid var(--border)' }}>30 days visible (hide, not delete)</td>
            <td style={{ padding: '8px', borderBottom: '1px solid var(--border)' }}>On Free, transcripts older than 30 days show an upgrade prompt; the data stays in your IndexedDB and becomes visible again on upgrade. Pro/Enterprise: unlimited.</td>
          </tr>
          <tr>
            <td style={{ padding: '8px', borderBottom: '1px solid var(--border)' }}>Usage analytics (local, non-identifying counters)</td>
            <td style={{ padding: '8px', borderBottom: '1px solid var(--border)' }}>180 days</td>
            <td style={{ padding: '8px', borderBottom: '1px solid var(--border)' }}>Stored in your browser only; events older than 180 days are pruned automatically.</td>
          </tr>
          <tr>
            <td style={{ padding: '8px', borderBottom: '1px solid var(--border)' }}>Account data</td>
            <td style={{ padding: '8px', borderBottom: '1px solid var(--border)' }}>While account is active</td>
            <td style={{ padding: '8px', borderBottom: '1px solid var(--border)' }}>Deleted on request or with your account (within 30 days, see Section 7).</td>
          </tr>
          <tr>
            <td style={{ padding: '8px', borderBottom: '1px solid var(--border)' }}>OAuth tokens (Zoom, Gmail, Outlook)</td>
            <td style={{ padding: '8px', borderBottom: '1px solid var(--border)' }}>While connection is active</td>
            <td style={{ padding: '8px', borderBottom: '1px solid var(--border)' }}>Stored encrypted; deleted on disconnect, uninstall, or deauthorization.</td>
          </tr>
          <tr>
            <td style={{ padding: '8px' }}>Billing records</td>
            <td style={{ padding: '8px' }}>7 years</td>
            <td style={{ padding: '8px' }}>Retained as required by law for accounting/tax purposes.</td>
          </tr>
        </tbody>
      </table>

      <h2 style={styles.h2}>7. Data Deletion &amp; Your Rights</h2>
      <p style={styles.p}>You have control over your data at all times:</p>
      <ul style={{ paddingLeft: '24px', marginTop: '8px' }}>
        <li style={styles.li}><strong style={styles.strong}>Delete meeting data:</strong> use the "Delete All Data" option in the DealForge dashboard (Settings → Data Management) to erase all local meetings, analyses, leads, emails, and settings, or clear your browser's site data at any time.</li>
        <li style={styles.li}><strong style={styles.strong}>Export:</strong> download a complete JSON backup of your local data from Settings → Export Data.</li>
        <li style={styles.li}><strong style={styles.strong}>Disconnect integrations:</strong> remove Zoom, Gmail, or Outlook connections from Settings → Integrations. Disconnecting deletes the associated encrypted tokens from our servers.</li>
        <li style={styles.li}><strong style={styles.strong}>Delete your account:</strong> email <strong style={styles.strong}>support@dealforge.com</strong> to request account and server-side data deletion. We will confirm and complete the deletion within 30 days.</li>
        <li style={styles.li}><strong style={styles.strong}>Zoom deauthorization:</strong> if you uninstall DealForge from your Zoom account, Zoom notifies us and we immediately delete the user's Zoom connection data and tokens.</li>
      </ul>
      <p style={styles.p}>
        Because your meeting content lives in your browser, deleting it there removes it from DealForge entirely —
        there is no server-side copy to request deletion of.
      </p>

      <h2 style={styles.h2}>8. Security</h2>
      <p style={styles.p}>
        We use industry-standard protections: all traffic is served over TLS (HTTPS); API keys are encrypted on
        your device with AES-256-GCM (PBKDF2, 600K iterations); server-side OAuth tokens are encrypted at rest with
        AES-256-GCM; webhooks and deauthorization requests are verified with HMAC-SHA256 signatures; and all API
        routes validate input and authenticate requests. No system is 100% secure — if you have a security
        concern, contact us at <strong style={styles.strong}>support@dealforge.com</strong>.
      </p>

      <h2 style={styles.h2}>9. Children's Privacy</h2>
      <p style={styles.p}>
        DealForge is a business tool intended for professional sales use. You must be at least 18 years old (or the
        age of majority in your jurisdiction; 16+ in the EU/EEA where that is the applicable minimum age) to use
        DealForge, consistent with our Terms of Service §2 (Eligibility). DealForge is not directed to children,
        and we do not knowingly collect personal information from anyone below the eligible age. If we learn that
        we have collected personal information from an ineligible minor, we will delete it promptly. If you believe
        a minor has provided us personal information, contact us at{' '}
        <strong style={styles.strong}>support@dealforge.com</strong>.
      </p>

      <h2 style={styles.h2}>10. International Data Transfers</h2>
      <p style={styles.p}>
        Our service providers (Firebase/Google, OpenAI, Anthropic, Gemini, Resend, Dodo) may process data in
        regions outside your country of residence. By using DealForge you consent to such processing, which is
        subject to the providers' own privacy and security commitments (including, where applicable, standard
        contractual clauses and equivalent transfer mechanisms).
      </p>

      <h2 style={styles.h2}>11. Changes to This Policy</h2>
      <p style={styles.p}>
        We may update this Privacy Policy from time to time. Material changes will be reflected by an updated
        "Last updated" date at the top of this page, and, where appropriate, we will notify you via the app.
        Continued use of DealForge after changes take effect constitutes acceptance of the revised policy.
      </p>

      <h2 style={styles.h2}>12. Contact Us</h2>
      <p style={styles.p}>
        Questions, privacy requests, or account deletion requests: <strong style={styles.strong}>support@dealforge.com</strong>.
      </p>
    </div>
  );
}
