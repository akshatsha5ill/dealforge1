import { useEffect, useState, memo } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useWebSocket, getMeetingIdFromZoomContext } from '../../hooks/useWebSocket';

interface Suggestion {
  title: string;
  content: string;
}

const SuggestionItem = memo(({ title, content }: Suggestion) => (
  <div style={{ padding: '16px', backgroundColor: 'var(--bg-secondary)', borderRadius: '12px', border: '1px solid var(--border)', borderLeft: '4px solid var(--accent-primary)', marginBottom: '16px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }}>
    <h3 style={{ fontWeight: 600, fontSize: '14px', margin: '0 0 4px 0' }}>{title}</h3>
    <p style={{ fontSize: '14px', color: 'var(--text-secondary)', margin: 0, lineHeight: 1.5 }}>{content}</p>
  </div>
));
SuggestionItem.displayName = 'SuggestionItem';

const SuggestionsView = () => {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const { subscribe, joinMeeting } = useWebSocket();
  const outletContext = useOutletContext<{ zoomContext?: Record<string, string | number | boolean> | null } | null>();
  const meetingId = getMeetingIdFromZoomContext(outletContext?.zoomContext ?? null);

  useEffect(() => {
    if (meetingId) joinMeeting(meetingId);
  }, [meetingId, joinMeeting]);

  useEffect(() => {
    const unsubscribe = subscribe('ai_suggestion', (suggestion: Suggestion) => {
      setSuggestions((prev) => [suggestion, ...prev]);
    });
    return () => unsubscribe();
  }, [subscribe]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', backgroundColor: 'var(--bg-primary)', padding: '16px', color: 'var(--text-primary)' }}>
      <h2 style={{ fontSize: '20px', fontWeight: 700, marginBottom: '16px' }}>Live Suggestions</h2>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {suggestions.length === 0 ? (
          <div style={{ color: 'var(--text-muted)', textAlign: 'center', marginTop: '40px' }}>
            AI is listening... Suggestions will appear here.
          </div>
        ) : (
          suggestions.map((s, idx) => (
            <SuggestionItem key={`${idx}-${s.title}`} title={s.title} content={s.content} />
          ))
        )}
      </div>
    </div>
  );
};

export default SuggestionsView;
