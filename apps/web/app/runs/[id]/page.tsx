import RunControlRoom from "../../../components/runs/RunControlRoom";

type RunDetailPageProps = {
  params: Promise<{ id: string }>;
};

export default async function RunDetailPage({ params }: RunDetailPageProps) {
  const { id } = await params;
  return <RunControlRoom sessionId={id} />;
}
