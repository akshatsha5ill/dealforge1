import { useEffect, useState, memo, useRef } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useWebSocket, getMeetingIdFromZoomContext } from '../../hooks/useWebSocket';

interface Transcript {
  speaker?: string;
  text: string;
}

const TranscriptItem = memo(({ speaker, text }: Transcript) => (
  <div style={{ marginBottom: '12px' }}>
    <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--accent-primary)', marginBottom: '4px', display: 'block' }}>
      {speaker || 'Speaker'}
    </span>
    <p style={{ fontSize: '14px', margin: 0, lineHeight: 1.5 }}>{text}</p>
  </div>
));
TranscriptItem.displayName = 'TranscriptItem';

const TranscriptionView = () => {
  const [transcripts, setTranscripts] = useState<Transcript[]>([]);
  const { subscribe, joinMeeting } = useWebSocket();
  const outletContext = useOutletContext<{ zoomContext?: Record<string, string | number | boolean> | null } | null>();
  const meetingId = getMeetingIdFromZoomContext(outletContext?.zoomContext ?? null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (meetingId) joinMeeting(meetingId);
  }, [meetingId, joinMeeting]);

  useEffect(() => {
    const unsubscribe = subscribe('transcription', (segment: Transcript) => {
      setTranscripts((prev) => {
        const next = [...prev, segment];
        if (listRef.current) {
          // Defer scroll to next tick to allow DOM update
          setTimeout(() => {
            if (listRef.current) {
              listRef.current.scrollTop = listRef.current.scrollHeight;
            }
          }, 0);
        }
        return next;
      });
    });
    return () => unsubscribe();
  }, [subscribe]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', backgroundColor: 'var(--bg-primary)', padding: '16px', color: 'var(--text-primary)' }}>
      <h2 style={{ fontSize: '20px', fontWeight: 700, marginBottom: '16px' }}>Live Transcription</h2>
      <div ref={listRef} style={{ flex: 1, overflowY: 'auto', padding: '16px', backgroundColor: 'var(--bg-secondary)', borderRadius: '12px', border: '1px solid var(--border)' }}>
        {transcripts.length === 0 ? (
          <div style={{ color: 'var(--text-muted)', textAlign: 'center', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            Waiting for transcription to start...
          </div>
        ) : (
          transcripts.map((t, idx) => (
            <TranscriptItem key={`${idx}-${t.speaker || 'unknown'}`} speaker={t.speaker} text={t.text} />
          ))
        )}
      </div>
    </div>
  );
};

export default TranscriptionView;
