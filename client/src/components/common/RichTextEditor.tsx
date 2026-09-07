import React, { useRef, useEffect } from 'react';
import DOMPurify from 'dompurify';
import { Bold, Italic, Underline, List, ListOrdered, AlignLeft, AlignCenter, AlignRight } from 'lucide-react';
import './RichTextEditor.css';

interface RichTextEditorProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

export const RichTextEditor: React.FC<RichTextEditorProps> = ({ value, onChange, placeholder }) => {
  const editorRef = useRef<HTMLDivElement>(null);
  
  // Set initial value only once to avoid cursor jumping
  useEffect(() => {
    if (editorRef.current && editorRef.current.innerHTML !== value) {
      editorRef.current.innerHTML = DOMPurify.sanitize(value || '');
    }
  }, [value]);

  const handleInput = () => {
    if (editorRef.current) {
      // Sanitize on emit as well as on render: innerHTML is attacker-influenced
      // via paste/contentEditable, and consumers store/render this value.
      onChange(DOMPurify.sanitize(editorRef.current.innerHTML));
    }
  };

  const execCommand = (command: string, arg: string | undefined = undefined) => {
    document.execCommand(command, false, arg);
    editorRef.current?.focus();
    handleInput();
  };

  return (
    <div className="rich-text-container">
      <div className="rich-text-toolbar">
        <button type="button" onClick={() => execCommand('bold')} className="toolbar-btn" title="Bold"><Bold size={16} /></button>
        <button type="button" onClick={() => execCommand('italic')} className="toolbar-btn" title="Italic"><Italic size={16} /></button>
        <button type="button" onClick={() => execCommand('underline')} className="toolbar-btn" title="Underline"><Underline size={16} /></button>
        <div className="toolbar-divider" />
        <button type="button" onClick={() => execCommand('insertUnorderedList')} className="toolbar-btn" title="Bullet List"><List size={16} /></button>
        <button type="button" onClick={() => execCommand('insertOrderedList')} className="toolbar-btn" title="Numbered List"><ListOrdered size={16} /></button>
        <div className="toolbar-divider" />
        <button type="button" onClick={() => execCommand('justifyLeft')} className="toolbar-btn" title="Align Left"><AlignLeft size={16} /></button>
        <button type="button" onClick={() => execCommand('justifyCenter')} className="toolbar-btn" title="Align Center"><AlignCenter size={16} /></button>
        <button type="button" onClick={() => execCommand('justifyRight')} className="toolbar-btn" title="Align Right"><AlignRight size={16} /></button>
      </div>
      <div
        ref={editorRef}
        className="rich-text-editor"
        contentEditable
        onInput={handleInput}
        onBlur={handleInput}
        data-placeholder={placeholder}
      />
    </div>
  );
};
