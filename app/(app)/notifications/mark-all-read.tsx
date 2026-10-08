"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { markRead } from "./actions";
import { Button } from "@/components/ui/button";

export function MarkAllRead() {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={pending}
      onClick={() =>
        start(async () => {
          await markRead();
          router.refresh();
        })
      }
    >
      Mark all read
    </Button>
  );
}
