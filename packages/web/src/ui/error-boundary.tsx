import { Component, type ReactNode } from "react";
import { useLocation } from "react-router";
import { ErrorAlert } from "./alert.tsx";
import { Button } from "./button.tsx";

interface Props {
  children: ReactNode;
  /** What failed to show, for the message: "this page", "this view". */
  what: string;
}

interface State {
  error: Error | undefined;
  pathname: string;
}

class Boundary extends Component<Props & { pathname: string }, State> {
  override state: State = { error: undefined, pathname: this.props.pathname };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  static getDerivedStateFromProps(props: { pathname: string }, state: State): Partial<State> | null {
    return props.pathname === state.pathname ? null : { error: undefined, pathname: props.pathname };
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
 * the app keeps working. Going to another address clears the message. With `remount` (a view), what's
 * inside is built afresh at each address too; without it (a page), it keeps its state, such as a
 * novel's open files and the saves under way.
 */
export function ErrorBoundary({ children, what, remount = false }: Props & { remount?: boolean }) {
  const { pathname } = useLocation();
  return (
    <Boundary key={remount ? pathname : undefined} pathname={pathname} what={what}>
      {children}
    </Boundary>
  );
}
