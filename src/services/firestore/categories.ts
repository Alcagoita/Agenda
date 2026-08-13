import { getDocs, addDoc, updateDoc, deleteDoc, query, orderBy } from '@react-native-firebase/firestore';
import type { Category } from '../../types';
import { categoriesRef, categoryRef } from './refs';
import { mapSnapshotDocs } from './snapshot';

/**
 * Create a new custom category.
 * Returns the auto-generated Firestore document ID.
 */
export async function addCategory(
  uid: string,
  data: Omit<Category, 'id' | 'isBuiltIn'>,
): Promise<string> {
  const ref = await addDoc(categoriesRef(uid), { ...data, isBuiltIn: false });
  return ref.id;
}

/**
 * Update a custom category's name or color.
 * Built-in categories should never be passed here.
 */
export async function updateCategory(
  uid: string,
  categoryId: string,
  data: Partial<Pick<Category, 'name' | 'color'>>,
): Promise<void> {
  const ref = categoryRef(uid, categoryId);
  await updateDoc(ref, data);
}

/**
 * Permanently delete a custom category.
 * The caller is responsible for ensuring it is not a built-in category.
 */
export async function deleteCategory(uid: string, categoryId: string): Promise<void> {
  await deleteDoc(categoryRef(uid, categoryId));
}

export async function getCategories(uid: string): Promise<Category[]> {
  const snap = await getDocs(query(categoriesRef(uid), orderBy('name', 'asc')));
  return mapSnapshotDocs<Category>(snap).map(c => ({ ...c, isBuiltIn: false }));
}
