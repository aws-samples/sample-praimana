"use client";

import { useParams, redirect } from "next/navigation";

export default function TeamRootPage() {
  const params = useParams();
  const workshopId = params.workshopId as string;
  const teamId = params.teamId as string;
  redirect(`/w/${workshopId}/t/${teamId}/team`);
}
