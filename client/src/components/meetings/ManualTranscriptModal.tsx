import { X, Upload, FileText } from 'lucide-react';
import React, { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import '../pipeline/Pipeline.css';
import { db } from '../../services/local-db/db';
import { parseTranscriptFile } from '../../utils/transcript-parser';
import { trackEvent } from '../../services/usage-analytics';
import { Meeting, Transcript } from '../../types';

interface ManualTranscriptModalProps {
  onClose: () => void;
}

const ACCEPTED_EXTENSIONS = ['.txt', '.srt', '.vtt'];

export const ManualTranscriptModal: React.FC<ManualTranscriptModalProps> = ({ onClose }) => {
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleFile = async (file: File) => {
    const ext = `.${file.name.split('.').pop()?.toLowerCase()}`;
    if (!ACCEPTED_EXTENSIONS.includes(ext)) {
      setError('Only .txt, .srt, and .vtt files are supported.');
      return;
    }
    setError('');
    const content = await file.text();
    setText(content);
    setFileName(file.name);
    trackEvent('transcript_uploaded');
    if (!title) {
      setTitle(file.name.replace(/\.[^.]+$/, ''));
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim()) {
      setError('Paste a transcript or upload a file.');
      return;
    }
    setSubmitting(true);
    try {
      const parsed = parseTranscriptFile(fileName || 'transcript.txt', text);
      if (!parsed.segments.length || parsed.fullText.trim().length < 20) {
        setError('Transcript is empty or too short. Paste at least 20 characters of meeting content.');
        setSubmitting(false);
        return;
      }
      const id = `meeting_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const now = new Date().toISOString();
      const meeting: Meeting = {
        id,
        zoomMeetingId: `manual_${id}`,
        title: title.trim() || fileName?.replace(/\.[^.]+$/, '') || 'Manual Meeting',
        startTime: now,
        endTime: new Date(Date.now() + parsed.durationSeconds * 1000).toISOString(),
        duration: Math.max(1, Math.round(parsed.durationSeconds / 60)),
        status: 'completed',
      };
      const transcript: Transcript = {
        id: `transcript_${id}`,
        meetingId: id,
        segments: parsed.segments,
        fullText: parsed.fullText,
        createdAt: now,
      };
      await db.transaction('rw', db.meetings, db.transcripts, async () => {
        await db.meetings.put(meeting);
        await db.transcripts.put(transcript);
      });
      trackEvent('meeting_created_manual');
      navigate(`/dashboard/meetings/${id}`);
    } catch (err) {
      console.error('Failed to save transcript:', err);
      setError('Failed to save the transcript. Please try again.');
      setSubmitting(false);
    }
  };

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };

  return (
    <div className="modal-overlay" onClick={handleOverlayClick}>
      <div className="modal" style={{ maxWidth: '640px', width: '100%' }}>
        <div className="modal-header">
          <div className="modal-title">Add Meeting Transcript</div>
          <button type="button" className="modal-close" onClick={onClose}>
            <X size={20} />
          </button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginBottom: '16px' }}>
              Paste a transcript from any meeting source (Zoom, Google Meet, Teams, in-person notes) or upload a{' '}
              .txt / .srt / .vtt file, then generate AI analysis.
            </p>

            <div className="form-group">
              <label className="form-label">Meeting Title</label>
              <input
                className="form-input"
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Discovery Call with Acme Corp"
              />
            </div>

            <div className="form-group">
              <label className="form-label">Transcript</label>
              <textarea
                className="form-input"
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={'Paste your transcript here...\n\nTip: format speaker turns as "Name: text" on separate lines for better analysis.'}
                rows={12}
                style={{ resize: 'vertical', fontFamily: 'monospace', fontSize: '13px', lineHeight: 1.6 }}
              />
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginTop: '4px' }}>
              <input
                ref={fileInputRef}
                type="file"
                accept={ACCEPTED_EXTENSIONS.join(',')}
                onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
                style={{ display: 'none' }}
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '8px 14px', backgroundColor: 'var(--bg-tertiary)', border: '1px solid var(--border)', borderRadius: '6px', cursor: 'pointer', color: 'var(--text-secondary)', fontSize: '13px', fontWeight: 500 }}
              >
                <Upload size={14} /> Upload File
              </button>
              {fileName ? (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', color: 'var(--success)', fontSize: '13px' }}>
                  <FileText size={14} /> {fileName}
                </span>
              ) : (
                <span style={{ color: 'var(--text-muted)', fontSize: '12px' }}>Supports .txt, .srt, .vtt</span>
              )}
            </div>

            {error && (
              <div style={{ marginTop: '12px', padding: '10px 12px', backgroundColor: 'rgba(239, 68, 68, 0.1)', border: '1px solid var(--danger)', borderRadius: '6px', color: 'var(--danger)', fontSize: '13px' }}>
                {error}
              </div>
            )}
          </div>
          <div className="modal-footer">
            <button type="button" className="btn-secondary" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn-primary" disabled={submitting}>
              {submitting ? 'Saving...' : 'Save & Open'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
