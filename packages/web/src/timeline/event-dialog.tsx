import type { EventFields } from "@gh-writer/client";
import type { Novel, StoryEvent } from "@gh-writer/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Dialog } from "radix-ui";
import { useId, useState, type FormEvent } from "react";
import { api, keys } from "../api.ts";
import { ErrorAlert } from "../ui/alert.tsx";
import { Button } from "../ui/button.tsx";
import { Confirm } from "../ui/confirm.tsx";
import { Field } from "../ui/field.tsx";

type Kind = "day" | "date" | "none";

/** Add an off-page event, or edit or delete one: its title, when, how long, who and where, and a note. */
export function EventDialog({ novelId, novel, event, onClose }: { novelId: string; novel: Novel; event: StoryEvent | undefined; onClose: () => void }) {
  const queryClient = useQueryClient();
  const id = useId();
  const w = event?.when;
  const [title, setTitle] = useState(event?.title ?? "");
  const [kind, setKind] = useState<Kind>(w ? ("at" in w ? "date" : "day") : "day");
  const [day, setDay] = useState(w && "day" in w ? String(w.day) : "1");
  const [date, setDate] = useState(w && "at" in w ? w.at.slice(0, 10) : "");
  const [time, setTime] = useState(w ? ("at" in w ? w.at.slice(11, 16) : (w.time ?? "")) : "");
  const [duration, setDuration] = useState(event?.duration ?? "");
  const [chosen, setChosen] = useState({ characters: event?.characters ?? [], locations: event?.locations ?? [], plotlines: event?.plotlines ?? [] });
  const [note, setNote] = useState(event?.note ?? "");

  const fields = (): EventFields & { title: string } => ({
    title: title.trim(),
    when: kind === "none" ? null : kind === "day" ? { day: Number(day), ...(time ? { time } : {}) } : { at: time ? `${date}T${time}` : date },
    duration: duration.trim() || null,
    characters: chosen.characters,
    locations: chosen.locations,
    plotlines: chosen.plotlines,
    note: note.trim() || null,
  });
  const done = async () => {
    await queryClient.invalidateQueries({ queryKey: keys.novel(novelId) });
    onClose();
  };
  const save = useMutation({
    mutationFn: () => {
      const f = fields();
      if (event) return api.bible.updateEvent(novelId, event.id, f);
      // A new event leaves out what isn't given.
      return api.bible.createEvent(novelId, Object.fromEntries(Object.entries(f).filter(([, v]) => v !== null && !(Array.isArray(v) && !v.length))) as EventFields & { title: string });
    },
    onSuccess: done,
  });
  const remove = useMutation({ mutationFn: () => api.bible.deleteEvent(novelId, event!.id), onSuccess: done });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (title.trim()) save.mutate();
  };
  const toggle = (list: keyof typeof chosen, value: string) =>
    setChosen((c) => ({ ...c, [list]: c[list].includes(value) ? c[list].filter((x) => x !== value) : [...c[list], value] }));
  const of = (type: string) => novel.entities.filter((e) => e.type === type).sort((a, b) => a.name.localeCompare(b.name));

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed top-1/2 left-1/2 z-50 grid max-h-[calc(100vh-2rem)] w-[min(34rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 gap-4 overflow-y-auto rounded-lg border border-rule bg-raised p-5 text-ink shadow-xl"
        >
          <Dialog.Title className="text-lg font-semibold">{event ? "Edit the event" : "New off-page event"}</Dialog.Title>
          <form onSubmit={submit} className="grid gap-3 text-sm">
            <Field label="Title" value={title} onChange={(e) => setTitle(e.target.value)} required autoFocus />
            <fieldset className="grid gap-2">
              <legend className="mb-1 font-medium">When</legend>
              <select aria-label="When it happens" value={kind} onChange={(e) => setKind(e.target.value as Kind)} className="h-9 rounded-md border border-rule bg-raised px-2">
                <option value="day">A day of the story</option>
                <option value="date">A date</option>
                <option value="none">Not given</option>
              </select>
              {kind !== "none" && (
                <div className="grid grid-cols-2 gap-2">
                  {kind === "day" ? (
                    <Field label="Day" type="number" value={day} onChange={(e) => setDay(e.target.value)} hint="Day 1 is the story's first; earlier days are 0 or less." />
                  ) : (
                    <Field label="Date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
                  )}
                  <Field label="Time" type="time" value={time} onChange={(e) => setTime(e.target.value)} hint="Optional." />
                </div>
              )}
            </fieldset>
            <Field label="Duration" value={duration} onChange={(e) => setDuration(e.target.value)} placeholder="PT2H" hint="Optional: PT45M is 45 minutes, P3D three days." />
            <div className="grid gap-3 sm:grid-cols-3">
              {(
                [
                  ["characters", "Characters", "character"],
                  ["locations", "Locations", "location"],
                  ["plotlines", "Plotlines", "plotline"],
                ] as const
              ).map(([list, legend, type]) => (
                <fieldset key={list} className="grid content-start gap-1">
                  <legend className="mb-1 font-medium">{legend}</legend>
                  <div className="grid max-h-36 gap-1 overflow-y-auto rounded-md border border-rule p-2">
                    {of(type).map((e) => (
                      <label key={e.id} className="flex items-center gap-2">
                        <input type="checkbox" checked={chosen[list].includes(e.id)} onChange={() => toggle(list, e.id)} />
                        {e.name}
                      </label>
                    ))}
                    {!of(type).length && <span className="text-muted">None in the bible.</span>}
                  </div>
                </fieldset>
              ))}
            </div>
            <label className="grid gap-1.5 font-medium" htmlFor={`${id}-note`}>
              Note
            </label>
            <textarea id={`${id}-note`} value={note} onChange={(e) => setNote(e.target.value)} rows={3} className="rounded-md border border-rule bg-raised px-3 py-2" />
            {(save.isError || remove.isError) && <ErrorAlert title="Couldn't save it">{(save.error ?? remove.error)?.message}</ErrorAlert>}
            <div className="flex flex-wrap justify-between gap-2">
              {event ? (
                <Confirm
                  title="Delete this event?"
                  description={`“${event.title}” will be taken off the timeline and out of the bible.`}
                  action="Delete"
                  danger
                  onConfirm={() => remove.mutate()}
                  trigger={<Button variant="danger">Delete</Button>}
                />
              ) : (
                <span />
              )}
              <div className="flex gap-2">
                <Button onClick={onClose}>Cancel</Button>
                <Button type="submit" variant="primary" disabled={!title.trim() || save.isPending}>
                  {event ? "Save" : "Add event"}
                </Button>
              </div>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
