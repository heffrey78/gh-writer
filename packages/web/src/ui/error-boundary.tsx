import { Component, type ReactNode } from "react";
import { useLocation } from "react-router";
import { ErrorAlert } from "./alert.tsx";
import { Button } from "./button.tsx";

interface Props {
  children: ReactNode;
  /** What failed to show, for the message: "this page", "this view". */
  what: string;
}

class Boundary extends Component<Props, { error: Error | undefined }> {
  override state: { error: Error | undefined } = { error: undefined };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error) {
    console.error(error);
  }

  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="px-6 py-6">
        <ErrorAlert title={`Something went wrong showing ${this.props.what}.`} detail={error.stack ?? error.message}>
          <p>Your text is safe: everything typed is saved or kept in this tab. Go somewhere else in the app, or try again.</p>
          <Button size="sm" className="mt-2" onClick={() => this.setState({ error: undefined })}>
            Try again
          </Button>
        </ErrorAlert>
      </div>
    );
  }
}

/**
 * A failure while rendering shows a message in place of what failed, not a blank page; the rest of
 * the app keeps working. Going to another address starts afresh.
 */
export function ErrorBoundary({ children, what }: Props) {
  const { pathname } = useLocation();
  return (
    <Boundary key={pathname} what={what}>
      {children}
    </Boundary>
  );
}
