import './BackupPrompt.css';

interface BackupPromptProps {
  onAuthorize: () => void;
}

export default function BackupPrompt({ onAuthorize }: BackupPromptProps) {
  return (
    <div className="backup-prompt ds-panel">
      <div className="ds-panel-head backup-prompt-head">
        <span className="ds-panel-title">Time for your weekly local backup.</span>
      </div>
      <button onClick={onAuthorize} className="ds-btn-primary backup-prompt-btn">
        Authorize Backup
      </button>
    </div>
  );
}
