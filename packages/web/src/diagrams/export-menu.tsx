import { Download } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { useNotice } from "../novel/notice.tsx";
import { Button } from "../ui/button.tsx";

/**
 * Take a diagram out of gh-writer: as an SVG file, and as Mermaid text where the diagram can be said
 * in it. Both come from the same renderers as the snapshots on github.com, for what the page shows.
 */
export function ExportMenu({ name, svg, mermaid }: { name: string; svg: () => string; mermaid?: (() => string) | undefined }) {
  const show = useNotice((n) => n.show);
  const item = "flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-accent-soft";
  const save = (text: string, type: string, file: string) => {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement("a");
    a.href = url;
    a.download = file;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(mermaid!());
      show({ message: "Copied the diagram as Mermaid: paste it into a ```mermaid block on GitHub." });
    } catch {
      show({ message: "Couldn't copy to the clipboard." });
    }
  };
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <Button size="sm">
          <Download className="size-4" aria-hidden /> Export
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal container={document.getElementById("main")}>
        <DropdownMenu.Content align="end" className="z-50 min-w-48 rounded-md border border-rule bg-raised p-1 text-ink shadow-lg">
          <DropdownMenu.Item className={item} onSelect={() => save(svg(), "image/svg+xml", `${name}.svg`)}>
            Download SVG
          </DropdownMenu.Item>
          {mermaid && (
            <>
              <DropdownMenu.Item className={item} onSelect={() => save(mermaid(), "text/vnd.mermaid", `${name}.mmd`)}>
                Download Mermaid (.mmd)
              </DropdownMenu.Item>
              <DropdownMenu.Item className={item} onSelect={() => void copy()}>
                Copy Mermaid
              </DropdownMenu.Item>
            </>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
