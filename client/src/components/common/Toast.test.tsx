import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import ToastContainer, { toast } from './Toast';

describe('Toast', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders nothing when no toasts are active', () => {
    render(<ToastContainer />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows toast when toast.success is called', () => {
    render(<ToastContainer />);

    act(() => {
      toast.success('Operation completed!');
    });

    expect(screen.getByText('Operation completed!')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('shows error toast', () => {
    render(<ToastContainer />);

    act(() => {
      toast.error('Something went wrong');
    });

    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
  });

  it('shows info toast', () => {
    render(<ToastContainer />);

    act(() => {
      toast.info('Here is some info');
    });

    expect(screen.getByText('Here is some info')).toBeInTheDocument();
  });

  it('auto-dismisses after 4 seconds', () => {
    render(<ToastContainer />);

    act(() => {
      toast.success('Will disappear');
    });

    expect(screen.getByText('Will disappear')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(4000);
    });

    expect(screen.queryByText('Will disappear')).not.toBeInTheDocument();
  });
});
