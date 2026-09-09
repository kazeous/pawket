import { prepareIncrementThreeDatabase } from "./increment-three-database";

export default async function prepareIncrementThreeDatabaseGlobalSetup() {
  await prepareIncrementThreeDatabase();
}
